import type { Env } from "../types";
import { sha256 } from "../utils/hash";

export interface DeliveryProgress {
  channels: string[];
  delivered: string[];
  checkpoint(): Promise<void>;
}

export interface Notifier {
  channelIds?(): Promise<string[]>;
  send(parts: string[], progress?: DeliveryProgress): Promise<void>;
}

let cachedBot:
  { token: string; username: string; expiresAt: number } | undefined;

export async function telegramBotUsername(token: string): Promise<string> {
  if (cachedBot?.token === token && cachedBot.expiresAt > Date.now())
    return cachedBot.username;
  const response = await fetch.call(
    globalThis,
    `https://api.telegram.org/bot${token}/getMe`,
    { signal: AbortSignal.timeout(5_000) },
  );
  const payload = await readJson(response);
  if (
    !response.ok ||
    !isRecord(payload) ||
    payload.ok !== true ||
    !isRecord(payload.result) ||
    payload.result.is_bot !== true ||
    typeof payload.result.username !== "string" ||
    !/^[A-Za-z0-9_]+$/.test(payload.result.username)
  )
    throw new Error("Telegram getMe failed");
  const username = payload.result.username.toLowerCase();
  cachedBot = { token, username, expiresAt: Date.now() + 5 * 60_000 };
  return username;
}

export class CompositeNotifier implements Notifier {
  constructor(
    private readonly notifiers: { id: string; notifier: Notifier }[],
  ) {}

  async channelIds(): Promise<string[]> {
    return this.notifiers.map(({ id }) => id);
  }

  async send(parts: string[], progress?: DeliveryProgress): Promise<void> {
    const channels = progress?.channels ?? (await this.channelIds());
    const errors: unknown[] = [];
    const deadline = Date.now() + 60_000;
    for (const id of channels) {
      const channel = this.notifiers.find((item) => item.id === id);
      // Removing a channel from configuration intentionally disables delivery,
      // including outstanding parts for that recipient.
      if (!channel) continue;
      try {
        for (const [index, part] of parts.entries()) {
          const receipt = `${id}:${index}`;
          if (progress?.delivered.includes(receipt)) continue;
          if (Date.now() >= deadline)
            throw new Error("Notification batch time budget reached");
          await channel.notifier.send([part]);
          if (progress) {
            progress.delivered.push(receipt);
            await progress.checkpoint();
          }
        }
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw new Error(
        "Notification delivery incomplete; pending parts will retry",
      );
  }
}

export class TelegramNotifier implements Notifier {
  constructor(
    private readonly token: string,
    private readonly chatId: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly signal?: AbortSignal,
    private readonly messageThreadId?: number,
  ) {}

  async send(parts: string[]): Promise<void> {
    for (const part of parts)
      await this.sendToChat(this.chatId, part, this.messageThreadId);
  }

  async sendToChat(
    chatId: string,
    text: string,
    messageThreadId?: number,
  ): Promise<void> {
    const response = await this.fetcher.call(
      globalThis,
      `https://api.telegram.org/bot${this.token}/sendMessage`,
      {
        method: "POST",
        signal: this.signal
          ? AbortSignal.any([this.signal, AbortSignal.timeout(10_000)])
          : AbortSignal.timeout(10_000),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          message_thread_id: messageThreadId,
          text,
          disable_web_page_preview: true,
        }),
      },
    );
    const payload = await readJson(response);
    if (!response.ok || !isRecord(payload) || payload.ok !== true) {
      throw new Error(
        `Telegram API request failed with HTTP ${response.status}`,
      );
    }
  }
}

export class WeComNotifier implements Notifier {
  constructor(
    private readonly webhookUrl: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly signal?: AbortSignal,
  ) {}

  async send(parts: string[]): Promise<void> {
    for (const part of parts) {
      const response = await this.fetcher.call(globalThis, this.webhookUrl, {
        method: "POST",
        signal: this.signal
          ? AbortSignal.any([this.signal, AbortSignal.timeout(10_000)])
          : AbortSignal.timeout(10_000),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          msgtype: "markdown",
          markdown: { content: part },
        }),
      });
      const payload = await readJson(response);
      if (!response.ok || !isRecord(payload) || payload.errcode !== 0) {
        throw new Error(
          `WeCom webhook request failed with HTTP ${response.status}`,
        );
      }
    }
  }
}

export async function createNotifier(
  env: Env,
  signal?: AbortSignal,
): Promise<CompositeNotifier> {
  const notifiers: { id: string; notifier: Notifier }[] = [];
  const telegram = createTelegramClient(env, signal);
  if (telegram) {
    notifiers.push({
      id: `telegram:${env.TELEGRAM_CHAT_ID!.trim()}${telegramThreadId(env) === undefined ? "" : `:thread:${telegramThreadId(env)}`}`,
      notifier: telegram,
    });
  }
  if (env.WECOM_WEBHOOK_URL)
    notifiers.push({
      id: `wecom:${await sha256(env.WECOM_WEBHOOK_URL)}`,
      notifier: new WeComNotifier(env.WECOM_WEBHOOK_URL, fetch, signal),
    });
  return new CompositeNotifier(notifiers);
}

export function createTelegramClient(
  env: Env,
  signal?: AbortSignal,
): TelegramNotifier | null {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) return null;
  return new TelegramNotifier(
    token,
    chatId,
    fetch,
    signal,
    telegramThreadId(env),
  );
}

export function telegramThreadId(env: Env): number | undefined {
  const value = env.TELEGRAM_MESSAGE_THREAD_ID?.trim();
  if (!value) return undefined;
  const id = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(id) || id <= 0)
    throw new Error("TELEGRAM_MESSAGE_THREAD_ID must be a positive integer");
  return id;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
