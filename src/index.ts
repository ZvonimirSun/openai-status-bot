import { loadConfig, resolveKv } from "./config";
import { OpenAIStatusClient } from "./clients/openai-status";
import { TranslationClient } from "./clients/translation-client";
import { createNotifier, createTelegramClient } from "./clients/notifiers";
import { buildCheckReply, buildNotificationParts } from "./domain/message";
import { MonitorStateRepository } from "./repositories/monitor-state";
import { MonitorService } from "./services/monitor";
import type { Env, MonitorRunResult, RunTrigger } from "./types";
import { bearerAuthorized, constantTimeEqual } from "./utils/auth";

export default {
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(runMonitor(env, "cron"));
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
      return Response.json(await runMonitor(env, "admin-check"));
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

export async function runMonitor(
  env: Env,
  trigger: RunTrigger,
): Promise<MonitorRunResult> {
  const cron = trigger === "cron";
  const signal = AbortSignal.timeout(cron ? 60_000 : 20_000);
  const config = loadConfig(env);
  const service = new MonitorService(
    config,
    new OpenAIStatusClient(fetch, signal),
    new MonitorStateRepository(resolveKv(env)),
    await createNotifier(env, signal),
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
  return service.run(trigger);
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
  if (!message || !isCheckCommand(message.text))
    return Response.json({ ok: true });
  if (message.chatId !== env.TELEGRAM_CHAT_ID?.trim()) return unauthorized();
  const work = processTelegramCheck(env, message.chatId);
  if (ctx) ctx.waitUntil(work);
  else await work;
  return Response.json({ ok: true });
}

async function processTelegramCheck(env: Env, chatId: string): Promise<void> {
  const config = loadConfig(env);
  let reply: string;
  try {
    const result = await runMonitor(env, "telegram-check");
    const summary = buildCheckReply(
      result.componentStatus,
      result.changed,
      result.events.length,
      new Date().toISOString(),
      config.displayTimeZone,
    );
    const details = buildNotificationParts(
      result.events,
      result.componentStatus ?? "unknown",
      new Date().toISOString(),
      config.displayTimeZone,
    );
    // One bounded query reply avoids multi-message fanout and webhook overruns.
    reply = details[0]
      ? `Codex API 实时查询（只读）\n${details[0]}${details.length > 1 ? "\n其余事件请查看官方状态页。" : ""}`
      : summary;
  } catch {
    reply = "Codex API 实时检查失败，请稍后重试。";
  }
  const telegram = createTelegramClient(env, AbortSignal.timeout(5_000));
  if (telegram) await telegram.sendToChat(chatId, reply);
}

function readTelegramMessage(
  value: unknown,
): { chatId: string; text: string } | null {
  if (!isRecord(value) || !isRecord(value.message)) return null;
  const message = value.message;
  if (!isRecord(message.chat) || typeof message.text !== "string") return null;
  const id = message.chat.id;
  if (typeof id !== "string" && typeof id !== "number") return null;
  return { chatId: String(id), text: message.text };
}

function isCheckCommand(text: string): boolean {
  return /^\/check(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(text.trim());
}

function unauthorized(): Response {
  return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
