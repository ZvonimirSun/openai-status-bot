import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";
import { components, incident, jsonResponse, MemoryKv } from "./helpers";

describe("worker handlers", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each<Env>([
    { TELEGRAM_BOT_TOKEN: "token", TELEGRAM_CHAT_ID: "123" },
    {
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_CHAT_ID: "123",
      TELEGRAM_WEBHOOK_SECRET: " ",
    },
    { TELEGRAM_CHAT_ID: "123", TELEGRAM_WEBHOOK_SECRET: "secret" },
    { TELEGRAM_BOT_TOKEN: "token", TELEGRAM_WEBHOOK_SECRET: "secret" },
  ])(
    "ignores webhook without complete Telegram configuration %j",
    async (env) => {
      const fetcher = vi.fn();
      vi.stubGlobal("fetch", fetcher);
      const response = await worker.fetch(
        new Request("https://example.com/telegram/webhook", {
          method: "POST",
          body: "not even JSON",
        }),
        env,
      );
      expect(response.status).toBe(200);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it("still rejects an invalid secret when webhook is enabled", async () => {
    const response = await worker.fetch(
      new Request("https://example.com/telegram/webhook", { method: "POST" }),
      {
        TELEGRAM_BOT_TOKEN: "token",
        TELEGRAM_CHAT_ID: "123",
        TELEGRAM_WEBHOOK_SECRET: "secret",
      },
    );
    expect(response.status).toBe(401);
  });

  it("HTTP check translates but never broadcasts or writes KV", async () => {
    const kv = new MemoryKv();
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        if (url.includes("components"))
          return jsonResponse({ components: components("major_outage") });
        if (url.includes("/proxy/"))
          return jsonResponse({
            summary: {
              ongoing_incidents: [
                incident("Codex API unavailable", new Date().toISOString()),
              ],
            },
          });
        if (url === "https://translation.example/v1/chat/completions")
          return jsonResponse({
            choices: [
              {
                message: {
                  content: JSON.stringify([
                    {
                      index: 0,
                      title: "translated title",
                      body: "translated body",
                    },
                  ]),
                },
              },
            ],
          });
        throw new Error("Unexpected broadcast request");
      },
    );
    vi.stubGlobal("fetch", fetcher);
    const result = await worker.fetch(
      new Request("https://worker.example/admin/check", {
        method: "POST",
        headers: { Authorization: "Bearer secret" },
      }),
      {
        STATUS_KV: kv.asNamespace(),
        CHECK_TOKEN: "secret",
        TELEGRAM_BOT_TOKEN: "token",
        TELEGRAM_CHAT_ID: "123",
        WECOM_WEBHOOK_URL: "https://wecom.example",
        TRANSLATION_API_BASE_URL: "https://translation.example/v1",
        TRANSLATION_API_KEY: "key",
        TRANSLATION_MODEL: "model",
      },
    );
    expect(await result.json()).toMatchObject({
      component: { status: "major_outage" },
      incidents: [
        expect.objectContaining({ translatedMessage: "translated body" }),
      ],
    });
    expect(kv.puts).toBe(0);
    expect(kv.gets).toBe(0);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("serves health and protects admin routes with CHECK_TOKEN", async () => {
    const kv = new MemoryKv();
    const env: Env = { STATUS_KV: kv.asNamespace(), CHECK_TOKEN: "secret" };
    const health = await worker.fetch(
      new Request("https://example.com/healthz"),
      env,
    );
    expect(health.status).toBe(200);
    const denied = await worker.fetch(
      new Request("https://example.com/admin/state", {
        headers: { Authorization: "Bearer wrong" },
      }),
      env,
    );
    expect(denied.status).toBe(401);
    const allowed = await worker.fetch(
      new Request("https://example.com/admin/state", {
        headers: { Authorization: "Bearer secret" },
      }),
      env,
    );
    expect(allowed.status).toBe(200);
  });

  it("queries without any KV binding and returns only the current snapshot", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes("components.json")
          ? jsonResponse({ components: components() })
          : jsonResponse({ summary: { ongoing_incidents: [] } }),
      ),
    );
    const response = await worker.fetch(
      new Request("https://example.com/admin/check", {
        method: "POST",
        headers: { Authorization: "Bearer secret" },
      }),
      { CHECK_TOKEN: "secret" },
    );
    const result = await response.json();
    expect(Object.keys(result as object).sort()).toEqual([
      "checkedAt",
      "component",
      "incidentFeedDegraded",
      "incidents",
      "monitoredComponents",
      "ok",
    ]);
  });

  it.each([
    {
      text: " @status_bot   /check ",
      chatType: "supergroup",
      threadId: undefined,
      configuredThread: undefined,
    },
    {
      text: "@status_bot /check @STATUS_BOT",
      chatType: "supergroup",
      threadId: 42,
      configuredThread: "42",
    },
    {
      text: "/check @status_bot",
      chatType: "supergroup",
      threadId: undefined,
      configuredThread: undefined,
    },
    {
      text: " /CHECK   @STATUS_BOT ",
      chatType: "supergroup",
      threadId: 1,
      configuredThread: "42",
    },
    {
      text: "/check @status_bot",
      chatType: "supergroup",
      threadId: 42,
      configuredThread: "42",
    },
    {
      text: "/check",
      chatType: "private",
      threadId: undefined,
      configuredThread: undefined,
    },
    {
      text: "/check@Status_Bot",
      chatType: "supergroup",
      threadId: 42,
      configuredThread: "99",
    },
    {
      text: "/CHECK@STATUS_BOT",
      chatType: "supergroup",
      threadId: 42,
      configuredThread: undefined,
    },
    {
      text: "/check",
      chatType: "private",
      threadId: undefined,
      configuredThread: "99",
    },
    {
      text: "/check",
      chatType: "supergroup",
      threadId: 42,
      configuredThread: "42",
    },
    {
      text: "/check@status_bot",
      chatType: "group",
      threadId: undefined,
      configuredThread: undefined,
    },
  ])(
    "handles Telegram checks as read-only in their original topic %j",
    async ({ text, chatType, threadId, configuredThread }) => {
      const kv = new MemoryKv();
      if (configuredThread !== undefined)
        kv.values.set(
          `telegram:topic:v1:123:token-${text}-${configuredThread}`,
          configuredThread,
        );
      const calls: string[] = [];
      const replies: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          calls.push(url);
          if (url.includes("components"))
            return jsonResponse({ components: components() });
          if (url.includes("/proxy/"))
            return jsonResponse({ summary: { ongoing_incidents: [] } });
          if (url.endsWith("/getMe"))
            return jsonResponse({
              ok: true,
              result: { is_bot: true, username: "status_bot" },
            });
          if (url.includes("api.telegram.org")) {
            const body = JSON.parse(String(init?.body));
            expect(body.chat_id).toBe("123");
            expect(body.message_thread_id).toBe(threadId);
            replies.push(body.text);
            return jsonResponse({ ok: true });
          }
          return jsonResponse({}, 404);
        }),
      );
      const env: Env = {
        STATUS_KV: kv.asNamespace(),
        TELEGRAM_BOT_TOKEN: `token-${text}-${configuredThread}`,
        TELEGRAM_CHAT_ID: "123",
        TELEGRAM_WEBHOOK_SECRET: "hook-secret",
        ...(configuredThread === undefined
          ? {}
          : { TELEGRAM_CHAT_MODE: "topic" }),
        WECOM_WEBHOOK_URL: "https://wecom.example",
      };
      const pending: Promise<unknown>[] = [];
      const ctx = {
        waitUntil(promise: Promise<unknown>) {
          pending.push(promise);
        },
        passThroughOnException() {},
        props: {},
      } as unknown as ExecutionContext;
      const response = await worker.fetch(
        new Request("https://example.com/telegram/webhook", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Telegram-Bot-Api-Secret-Token": "hook-secret",
          },
          body: JSON.stringify({
            message: {
              chat: { id: 123, type: chatType },
              text,
              message_thread_id: threadId,
            },
          }),
        }),
        env,
        ctx,
      );
      expect(response.status).toBe(200);
      await Promise.all(pending);
      expect(kv.puts).toBe(0);
      expect(kv.gets).toBe(
        text === "/check" &&
          chatType !== "private" &&
          configuredThread !== undefined
          ? 1
          : 0,
      );
      expect(replies[0]!.split("\n")).toHaveLength(3);
      expect(replies[0]).toContain("正常");
      expect(calls.filter((url) => url.endsWith("/sendMessage"))).toHaveLength(
        1,
      );
    },
  );

  it.each([
    { text: "/check@other_bot", chatId: 123, status: 200 },
    { text: "/check @other_bot", chatId: 123, status: 200 },
    { text: "/check @status_bot", chatId: 456, status: 401 },
    { text: "/check @status_bot.invalid", chatId: 123, status: 200 },
    { text: "/check @status_bot @other_bot", chatId: 123, status: 200 },
    { text: "/checker", chatId: 123, status: 200 },
    { text: "hello @status_bot", chatId: 123, status: 200 },
    { text: "/check extra @status_bot", chatId: 123, status: 200 },
    { text: "/check@status_bot", chatId: 456, status: 401 },
  ])(
    "does not execute unintended commands %j",
    async ({ text, chatId, status }) => {
      const fetcher = vi.fn(async () =>
        jsonResponse({
          ok: true,
          result: { is_bot: true, username: "status_bot" },
        }),
      );
      vi.stubGlobal("fetch", fetcher);
      const response = await worker.fetch(
        new Request("https://example.com/telegram/webhook", {
          method: "POST",
          headers: { "X-Telegram-Bot-Api-Secret-Token": "secret" },
          body: JSON.stringify({
            message: { chat: { id: chatId, type: "supergroup" }, text },
          }),
        }),
        {
          TELEGRAM_BOT_TOKEN: `unintended-${text}`,
          TELEGRAM_CHAT_ID: "123",
          TELEGRAM_WEBHOOK_SECRET: "secret",
        },
      );
      expect(response.status).toBe(status);
      expect(fetcher).toHaveBeenCalledTimes(
        text.includes("@other_bot") ? 1 : 0,
      );
    },
  );

  it.each([
    {
      text: "/check",
      chatType: "group",
      threadId: undefined,
      configuredThread: undefined,
    },
    {
      text: "/check",
      chatType: "supergroup",
      threadId: 42,
      configuredThread: undefined,
    },
    {
      text: "/check",
      chatType: "supergroup",
      threadId: 42,
      configuredThread: "99",
    },
    {
      text: "/check",
      chatType: "supergroup",
      threadId: undefined,
      configuredThread: "42",
    },
    {
      text: "/check@other_bot",
      chatType: "supergroup",
      threadId: 42,
      configuredThread: "42",
    },
    {
      text: "hello",
      chatType: "supergroup",
      threadId: 42,
      configuredThread: "42",
    },
    {
      text: "@status_bot hello",
      chatType: "supergroup",
      threadId: 42,
      configuredThread: "42",
    },
    {
      text: "/check",
      chatType: "channel",
      threadId: 42,
      configuredThread: "42",
    },
  ])(
    "ignores non-target group commands and ordinary text %j",
    async ({ text, chatType, threadId, configuredThread }) => {
      const fetcher = vi.fn(async () =>
        jsonResponse({
          ok: true,
          result: { is_bot: true, username: "status_bot" },
        }),
      );
      vi.stubGlobal("fetch", fetcher);
      const response = await worker.fetch(
        new Request("https://example.com/telegram/webhook", {
          method: "POST",
          headers: { "X-Telegram-Bot-Api-Secret-Token": "secret" },
          body: JSON.stringify({
            message: {
              chat: { id: 123, type: chatType },
              text,
              message_thread_id: threadId,
            },
          }),
        }),
        {
          TELEGRAM_BOT_TOKEN: `ignored-${text}`,
          TELEGRAM_CHAT_ID: "123",
          TELEGRAM_WEBHOOK_SECRET: "secret",
          ...(configuredThread === undefined
            ? {}
            : {
                TELEGRAM_CHAT_MODE: "topic",
                STATUS_KV: new MemoryKv().asNamespace(),
              }),
        },
      );
      expect(response.status).toBe(200);
      expect(fetcher).toHaveBeenCalledTimes(
        text === "/check@other_bot" ? 1 : 0,
      );
    },
  );

  it("returns a retryable response when bot identity cannot be verified", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ ok: false }, 503));
    vi.stubGlobal("fetch", fetcher);
    const response = await worker.fetch(
      new Request("https://example.com/telegram/webhook", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": "secret" },
        body: JSON.stringify({
          message: {
            chat: { id: 123, type: "group" },
            text: "/check@status_bot",
          },
        }),
      }),
      {
        TELEGRAM_BOT_TOKEN: "identity-failure",
        TELEGRAM_CHAT_ID: "123",
        TELEGRAM_WEBHOOK_SECRET: "secret",
      },
    );
    expect(response.status).toBe(503);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
