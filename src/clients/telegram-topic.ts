import type { Env } from "../types";
import {
  TelegramApiError,
  type Notifier,
  type TelegramNotifier,
} from "./notifiers";

export function telegramTopicMode(env: Env): boolean {
  const mode = env.TELEGRAM_CHAT_MODE?.trim().toLowerCase() || "direct";
  if (mode !== "direct" && mode !== "topic")
    throw new Error("TELEGRAM_CHAT_MODE must be direct or topic");
  return mode === "topic";
}

function topicKey(env: Env): string {
  // Bot ID stays stable when its token is rotated.
  const botId = env.TELEGRAM_BOT_TOKEN!.trim().split(":")[0];
  return `telegram:topic:v1:${env.TELEGRAM_CHAT_ID!.trim()}:${botId}`;
}

export async function readTelegramTopic(env: Env): Promise<number | null> {
  if (!telegramTopicMode(env)) return null;
  if (!env.STATUS_KV) throw new Error("STATUS_KV is required for topic mode");
  const value = await env.STATUS_KV.get(topicKey(env));
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export class TelegramTopicNotifier implements Notifier {
  private threadId: number | undefined;

  constructor(
    private readonly env: Env,
    private readonly telegram: TelegramNotifier,
    private readonly signal?: AbortSignal,
  ) {}

  private async api(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const response = await fetch.call(
      globalThis,
      `https://api.telegram.org/bot${this.env.TELEGRAM_BOT_TOKEN!.trim()}/${method}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
        signal: this.signal
          ? AbortSignal.any([this.signal, AbortSignal.timeout(5_000)])
          : AbortSignal.timeout(5_000),
      },
    );
    const payload = (await response.json()) as {
      ok?: boolean;
      result?: unknown;
    };
    if (
      !response.ok ||
      payload.ok !== true ||
      !payload.result ||
      typeof payload.result !== "object"
    )
      throw new TelegramApiError(
        response.status,
        "Telegram " + method + " failed",
      );
    return payload.result as Record<string, unknown>;
  }

  private async ensureTopic(): Promise<number> {
    if (this.threadId !== undefined) return this.threadId;
    const chatId = this.env.TELEGRAM_CHAT_ID!.trim();
    const me = await this.api("getMe", {});
    if (
      me.is_bot !== true ||
      typeof me.id !== "number" ||
      !Number.isSafeInteger(me.id)
    )
      throw new Error("Telegram getMe returned an invalid bot identity");
    const chat = await this.api("getChat", { chat_id: chatId });
    const member = await this.api("getChatMember", {
      chat_id: chatId,
      user_id: me.id,
    });
    if (chat.type !== "supergroup" || chat.is_forum !== true)
      throw new Error("Telegram topic mode requires a forum supergroup");
    if (member.status !== "administrator" || member.can_manage_topics !== true)
      throw new Error(
        "Telegram topic mode requires an administrator with can_manage_topics",
      );
    let id = await readTelegramTopic(this.env);
    if (id === null) {
      if (typeof me.first_name !== "string" || !me.first_name.trim())
        throw new Error("Telegram getMe returned no bot display name");
      const name = [
        me.first_name,
        typeof me.last_name === "string" ? me.last_name : "",
      ]
        .filter(Boolean)
        .join(" ");
      const topic = await this.api("createForumTopic", {
        chat_id: chatId,
        name: Array.from(name).slice(0, 128).join(""),
      });
      const created = topic.message_thread_id;
      if (
        typeof created !== "number" ||
        !Number.isSafeInteger(created) ||
        created <= 0
      )
        throw new Error(
          "Telegram createForumTopic returned an invalid topic ID",
        );
      await this.env.STATUS_KV!.put(topicKey(this.env), String(created));
      id = created;
    }
    this.threadId = id;
    return id;
  }

  private async recreateTopic(): Promise<number> {
    await this.env.STATUS_KV!.delete(topicKey(this.env));
    this.threadId = undefined;
    return this.ensureTopic();
  }

  async send(parts: string[]): Promise<void> {
    if (parts.length === 0) return;
    const chatId = this.env.TELEGRAM_CHAT_ID!.trim();
    await this.ensureTopic();
    for (const part of parts) {
      try {
        await this.telegram.sendToChat(chatId, part, this.threadId);
      } catch (error) {
        if (
          !(error instanceof TelegramApiError) ||
          error.status !== 400 ||
          !/(thread|topic).*(not found|deleted|closed|invalid)/i.test(
            error.description,
          )
        )
          throw error;
        await this.recreateTopic();
        await this.telegram.sendToChat(chatId, part, this.threadId);
      }
    }
  }
}
