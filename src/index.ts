import { loadConfig, resolveKv } from "./config";
import { OpenAIStatusClient } from "./clients/openai-status";
import { TranslationClient } from "./clients/translation-client";
import {
  createNotifier,
  createTelegramClient,
  telegramBotUsername,
  telegramThreadId,
} from "./clients/notifiers";
import { buildCurrentStatusReply } from "./domain/message";
import { MonitorStateRepository } from "./repositories/monitor-state";
import { MonitorService } from "./services/monitor";
import type { Env, MonitorRunResult, CurrentStatusResult } from "./types";
import { bearerAuthorized, constantTimeEqual } from "./utils/auth";

export default {
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(runCron(env));
  },

  async fetch(
    request: Request,
    env: Env,
    ctx?: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    if (
      request.method === "GET" &&
      (url.pathname === "/healthz" || url.pathname === "/")
    ) {
      return Response.json({
        ok: true,
        service: "openai-codex-status-wecom-worker",
      });
    }
    if (request.method === "POST" && url.pathname === "/telegram/webhook") {
      return handleTelegramWebhook(request, env, ctx);
    }
    if (url.pathname === "/admin/check" && request.method === "POST") {
      const config = loadConfig(env);
      if (!bearerAuthorized(request, config.adminToken)) return unauthorized();
      return Response.json(await checkCurrent(env));
    }
    if (url.pathname === "/admin/state" && request.method === "GET") {
      const config = loadConfig(env);
      if (!bearerAuthorized(request, config.adminToken)) return unauthorized();
      return Response.json({
        state: await new MonitorStateRepository(resolveKv(env)).load(),
      });
    }
    return new Response("Not Found", { status: 404 });
  },
};

export async function runCron(env: Env): Promise<MonitorRunResult> {
  return (await createService(env, true)).runCron();
}

export async function checkCurrent(env: Env): Promise<CurrentStatusResult> {
  return (await createService(env, false)).checkCurrent();
}

async function createService(env: Env, cron: boolean): Promise<MonitorService> {
  const signal = AbortSignal.timeout(cron ? 60_000 : 20_000);
  const config = loadConfig(env);
  return new MonitorService(
    config,
    new OpenAIStatusClient(fetch, signal),
    cron ? new MonitorStateRepository(resolveKv(env)) : null,
    cron ? await createNotifier(env, signal) : null,
    new TranslationClient(
      {
        baseUrl: config.translationApiBaseUrl,
        apiKey: config.translationApiKey,
        model: config.translationModel,
        style: config.translationApiStyle,
      },
      fetch,
      signal,
    ),
  );
}

async function handleTelegramWebhook(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  const secret = env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (!secret || !createTelegramClient(env)) return Response.json({ ok: true });
  if (
    !constantTimeEqual(
      request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "",
      secret,
    )
  ) {
    return unauthorized();
  }
  const update = (await request.json()) as unknown;
  const message = readTelegramMessage(update);
  if (!message) return Response.json({ ok: true });
  const command = /^\/check(?:@([A-Za-z0-9_]+))?(?:\s|$)/i.exec(
    message.text.trim(),
  );
  if (!command) return Response.json({ ok: true });
  if (message.chatId !== env.TELEGRAM_CHAT_ID?.trim()) return unauthorized();
  if (command[1]) {
    try {
      if (
        command[1].toLowerCase() !==
        (await telegramBotUsername(env.TELEGRAM_BOT_TOKEN!.trim()))
      )
        return Response.json({ ok: true });
    } catch {
      console.warn("Telegram getMe failed; command will be retried");
      return Response.json(
        { ok: false, error: "telegram_unavailable" },
        { status: 503 },
      );
    }
  } else if (message.chatType !== "private") {
    const topic = telegramThreadId(env);
    if (topic === undefined || message.messageThreadId !== topic)
      return Response.json({ ok: true });
  }
  const work = processTelegramCheck(
    env,
    message.chatId,
    message.messageThreadId,
  );
  if (ctx) ctx.waitUntil(work);
  else await work;
  return Response.json({ ok: true });
}

async function processTelegramCheck(
  env: Env,
  chatId: string,
  messageThreadId?: number,
): Promise<void> {
  const config = loadConfig(env);
  let reply: string;
  try {
    reply = buildCurrentStatusReply(
      await checkCurrent(env),
      config.displayTimeZone,
    );
  } catch {
    reply = "Codex 实时检查失败，请稍后重试。";
  }
  const telegram = createTelegramClient(env, AbortSignal.timeout(5_000));
  if (telegram) await telegram.sendToChat(chatId, reply, messageThreadId);
}

function readTelegramMessage(value: unknown): TelegramMessage | null {
  if (!isRecord(value) || !isRecord(value.message)) return null;
  const message = value.message;
  if (!isRecord(message.chat) || typeof message.text !== "string") return null;
  const id = message.chat.id;
  if (typeof id !== "string" && typeof id !== "number") return null;
  const chatType = message.chat.type;
  if (
    chatType !== "private" &&
    chatType !== "group" &&
    chatType !== "supergroup"
  )
    return null;
  const threadId = message.message_thread_id;
  if (
    threadId !== undefined &&
    (typeof threadId !== "number" ||
      !Number.isSafeInteger(threadId) ||
      threadId <= 0)
  )
    return null;
  return {
    chatId: String(id),
    chatType,
    text: message.text,
    ...(threadId === undefined ? {} : { messageThreadId: threadId }),
  };
}

interface TelegramMessage {
  chatId: string;
  chatType: "private" | "group" | "supergroup";
  text: string;
  messageThreadId?: number;
}

function unauthorized(): Response {
  return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
