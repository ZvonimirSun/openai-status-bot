import { afterEach, describe, expect, it, vi } from "vitest";
import { createNotifier } from "../src/clients/notifiers";
import { readTelegramTopic } from "../src/clients/telegram-topic";
import type { Env } from "../src/types";
import { jsonResponse, MemoryKv } from "./helpers";

describe("automatic Telegram topics", () => {
  afterEach(() => vi.unstubAllGlobals());

  function setup(
    options: {
      admin?: boolean;
      manage?: boolean;
      forum?: boolean;
      failCreate?: boolean;
      failSend?: boolean;
    } = {},
  ) {
    const kv = new MemoryKv();
    const env: Env = {
      STATUS_KV: kv.asNamespace(),
      TELEGRAM_BOT_TOKEN: "123:token",
      TELEGRAM_CHAT_ID: "-1001",
      TELEGRAM_CHAT_MODE: "topic",
    };
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        const method = String(input).split("/").pop();
        const body = JSON.parse(String(init?.body));
        if (method === "getMe")
          return jsonResponse({
            ok: true,
            result: { id: 123, is_bot: true, first_name: "Status Bot" },
          });
        if (method === "getChat")
          return jsonResponse({
            ok: true,
            result: { type: "supergroup", is_forum: options.forum ?? true },
          });
        if (method === "getChatMember") {
          expect(body).toEqual({ chat_id: "-1001", user_id: 123 });
          return jsonResponse({
            ok: true,
            result: {
              status: options.admin === false ? "member" : "administrator",
              can_manage_topics: options.manage ?? true,
            },
          });
        }
        if (method === "createForumTopic") {
          expect(body).toEqual({ chat_id: "-1001", name: "Status Bot" });
          return options.failCreate
            ? jsonResponse({ ok: false }, 403)
            : jsonResponse({ ok: true, result: { message_thread_id: 42 } });
        }
        if (method === "sendMessage") {
          expect(body.message_thread_id).toBe(42);
          return jsonResponse({ ok: !options.failSend });
        }
        throw new Error(`Unexpected method ${method}`);
      },
    );
    vi.stubGlobal("fetch", fetcher);
    return { env, kv, fetcher };
  }

  it("creates only on delivery, persists and reuses across clients and token rotation", async () => {
    const { env, kv, fetcher } = setup();
    const notifier = await createNotifier(env);
    expect(await notifier.channelIds()).toEqual(["telegram:-1001:topic"]);
    expect(fetcher).not.toHaveBeenCalled();
    expect(kv.gets).toBe(0);
    await notifier.send(["first", "second"]);
    expect(kv.puts).toBe(1);
    expect(await readTelegramTopic(env)).toBe(42);
    await (
      await createNotifier({ ...env, TELEGRAM_BOT_TOKEN: "123:rotated" })
    ).send(["third"]);
    expect(
      fetcher.mock.calls.filter(([url]) =>
        String(url).endsWith("/createForumTopic"),
      ),
    ).toHaveLength(1);
    expect(kv.puts).toBe(1);
  });

  it.each([
    { admin: false },
    { manage: false },
    { forum: false },
    { failCreate: true },
  ])(
    "fails closed without required permissions or forum %j",
    async (options) => {
      const { env, kv, fetcher } = setup(options);
      await expect((await createNotifier(env)).send(["body"])).rejects.toThrow(
        "incomplete",
      );
      expect(kv.puts).toBe(0);
      expect(
        fetcher.mock.calls.some(([url]) =>
          String(url).endsWith("/sendMessage"),
        ),
      ).toBe(false);
    },
  );

  it("retains the topic record on delivery failure instead of creating duplicates", async () => {
    const { env, kv, fetcher } = setup({ failSend: true });
    await expect((await createNotifier(env)).send(["body"])).rejects.toThrow();
    await expect((await createNotifier(env)).send(["body"])).rejects.toThrow();
    expect(kv.puts).toBe(1);
    expect(
      fetcher.mock.calls.filter(([url]) =>
        String(url).endsWith("/createForumTopic"),
      ),
    ).toHaveLength(1);
  });

  it("checks permissions even when reusing a recorded topic", async () => {
    const { env, kv, fetcher } = setup({ manage: false });
    kv.values.set("telegram:topic:v1:-1001:123", "42");
    await expect((await createNotifier(env)).send(["body"])).rejects.toThrow();
    expect(
      fetcher.mock.calls.some(([url]) => String(url).endsWith("/sendMessage")),
    ).toBe(false);
    expect(kv.puts).toBe(0);
  });

  it("recreates a deleted topic and retries the failed part once", async () => {
    const { env, kv, fetcher } = setup();
    kv.values.set("telegram:topic:v1:-1001:123", "7");
    let stale = true;
    fetcher.mockImplementation(async (input, init) => {
      const method = String(input).split("/").pop();
      if (method === "sendMessage" && stale) {
        stale = false;
        return jsonResponse(
          { ok: false, description: "Bad Request: message thread not found" },
          400,
        );
      }
      if (method === "sendMessage") return jsonResponse({ ok: true });
      if (method === "getMe")
        return jsonResponse({
          ok: true,
          result: { id: 123, is_bot: true, first_name: "Status Bot" },
        });
      if (method === "getChat")
        return jsonResponse({
          ok: true,
          result: { type: "supergroup", is_forum: true },
        });
      if (method === "getChatMember")
        return jsonResponse({
          ok: true,
          result: { status: "administrator", can_manage_topics: true },
        });
      if (method === "createForumTopic")
        return jsonResponse({ ok: true, result: { message_thread_id: 42 } });
      throw new Error(`Unexpected method ${method}`);
    });
    await (await createNotifier(env)).send(["body"]);
    expect(kv.values.get("telegram:topic:v1:-1001:123")).toBe("42");
    expect(
      fetcher.mock.calls.filter(([url]) =>
        String(url).endsWith("/createForumTopic"),
      ),
    ).toHaveLength(1);
    expect(
      fetcher.mock.calls.filter(([url]) =>
        String(url).endsWith("/sendMessage"),
      ),
    ).toHaveLength(2);
  });

  it("does not block healthy channels when Telegram topic setup fails", async () => {
    const { env, fetcher } = setup({ manage: false });
    const telegramFetch = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (input, init) =>
      String(input) === "https://wecom.example"
        ? jsonResponse({ errcode: 0 })
        : telegramFetch(input, init),
    );
    await expect(
      (
        await createNotifier({
          ...env,
          WECOM_WEBHOOK_URL: "https://wecom.example",
        })
      ).send(["body"]),
    ).rejects.toThrow();
    expect(
      fetcher.mock.calls.some(([url]) => url === "https://wecom.example"),
    ).toBe(true);
  });
});
