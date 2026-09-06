import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";
import { component, incident, jsonResponse, MemoryKv } from "./helpers";

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
          return jsonResponse({ components: [component()] });
        if (url.includes("incidents"))
          return jsonResponse({
            incidents: [
              incident("Codex API unavailable", new Date().toISOString()),
            ],
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
      trigger: "admin-check",
      committed: false,
      notified: false,
      events: [expect.objectContaining({ translatedBody: "translated body" })],
    });
    expect(kv.puts).toBe(0);
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

  it("handles Telegram /check as read-only and only replies to the configured chat", async () => {
    const kv = new MemoryKv();
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("components"))
          return jsonResponse({ components: [component()] });
        if (url.includes("incidents")) return jsonResponse({ incidents: [] });
        if (url.includes("api.telegram.org")) return jsonResponse({ ok: true });
        return jsonResponse({}, 404);
      }),
    );
    const env: Env = {
      STATUS_KV: kv.asNamespace(),
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_CHAT_ID: "123",
      TELEGRAM_WEBHOOK_SECRET: "hook-secret",
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
          message: { chat: { id: 123 }, text: "/check" },
        }),
      }),
      env,
      ctx,
    );
    expect(response.status).toBe(200);
    await Promise.all(pending);
    expect(kv.puts).toBe(0);
    expect(
      calls.filter((url) => url.includes("api.telegram.org")),
    ).toHaveLength(1);
  });
});
