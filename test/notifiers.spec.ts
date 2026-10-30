import { describe, expect, it, vi } from "vitest";
import {
  CompositeNotifier,
  createNotifier,
  createTelegramClient,
  TelegramNotifier,
  telegramBotUsername,
  WeComNotifier,
} from "../src/clients/notifiers";
import type { DeliveryProgress } from "../src/clients/notifiers";
import type { Env } from "../src/types";
import { jsonResponse } from "./helpers";

describe("notification delivery", () => {
  it("caches bot identity briefly per token and retries failures", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: false }, 503))
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          result: { is_bot: true, username: "First_Bot" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          result: { is_bot: true, username: "Renamed_Bot" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          result: { is_bot: true, username: "Second_Bot" },
        }),
      );
    vi.stubGlobal("fetch", fetcher);
    try {
      await expect(telegramBotUsername("identity-one")).rejects.toThrow();
      expect(await telegramBotUsername("identity-one")).toBe("first_bot");
      expect(await telegramBotUsername("identity-one")).toBe("first_bot");
      expect(fetcher).toHaveBeenCalledTimes(2);
      now.mockReturnValue(301_001);
      expect(await telegramBotUsername("identity-one")).toBe("renamed_bot");
      expect(await telegramBotUsername("identity-two")).toBe("second_bot");
      expect(fetcher).toHaveBeenCalledTimes(4);
    } finally {
      now.mockRestore();
      vi.unstubAllGlobals();
    }
  });
  it.each<Env>([
    {},
    { TELEGRAM_BOT_TOKEN: "token" },
    { TELEGRAM_CHAT_ID: "123" },
    { TELEGRAM_BOT_TOKEN: " ", TELEGRAM_CHAT_ID: "123" },
  ])("skips incomplete Telegram config %j", async (env) => {
    expect(createTelegramClient(env)).toBeNull();
    const notifier = await createNotifier(env);
    expect(await notifier.channelIds()).toEqual([]);
    await expect(notifier.send(["body"])).resolves.toBeUndefined();
  });

  it("enables Telegram notifications without a webhook secret", async () => {
    const notifier = await createNotifier({
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_CHAT_ID: "123",
    });
    expect(await notifier.channelIds()).toEqual(["telegram:123"]);
  });

  it("allows WeCom without Telegram", async () => {
    const notifier = await createNotifier({
      WECOM_WEBHOOK_URL: "https://wecom.example",
    });
    expect(await notifier.channelIds()).toEqual([
      expect.stringMatching(/^wecom:/),
    ]);
  });

  it.each([undefined, "", " ", " 42 "])(
    "routes notifications to optional topic %j",
    async (threadId) => {
      const fetcher = vi.fn(async () => jsonResponse({ ok: true }));
      vi.stubGlobal("fetch", fetcher);
      try {
        const notifier = await createNotifier({
          TELEGRAM_BOT_TOKEN: "token",
          TELEGRAM_CHAT_ID: "-100123",
          ...(threadId === undefined
            ? {}
            : { TELEGRAM_MESSAGE_THREAD_ID: threadId }),
        });
        expect(await notifier.channelIds()).toEqual([
          threadId?.trim() ? "telegram:-100123:thread:42" : "telegram:-100123",
        ]);
        await notifier.send(["first", "second"]);
        expect(fetcher).toHaveBeenCalledTimes(2);
        for (const call of fetcher.mock.calls as unknown as [
          string,
          RequestInit,
        ][]) {
          const body = JSON.parse(String(call[1].body));
          expect(body.chat_id).toBe("-100123");
          if (threadId?.trim()) expect(body.message_thread_id).toBe(42);
          else expect(body).not.toHaveProperty("message_thread_id");
        }
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it.each(["0", "-1", "1.5", "abc", "1e2", "9007199254740992"])(
    "rejects invalid topic ID %s",
    (threadId) => {
      expect(() =>
        createTelegramClient({
          TELEGRAM_BOT_TOKEN: "token",
          TELEGRAM_CHAT_ID: "123",
          TELEGRAM_MESSAGE_THREAD_ID: threadId,
        }),
      ).toThrow("positive integer");
    },
  );
  it("finishes healthy channels and resumes only missing parts", async () => {
    const telegram = { send: vi.fn(async () => {}) };
    const wecom = {
      send: vi.fn(async (parts: string[]) => {
        if (parts[0] === "second") throw new Error("down");
      }),
    };
    const notifier = new CompositeNotifier([
      { id: "wecom", notifier: wecom },
      { id: "telegram", notifier: telegram },
    ]);
    const progress: DeliveryProgress = {
      channels: ["wecom", "telegram"],
      delivered: [],
      checkpoint: vi.fn(async () => {}),
    };
    await expect(notifier.send(["first", "second"], progress)).rejects.toThrow(
      "incomplete",
    );
    expect(telegram.send.mock.calls).toHaveLength(2);
    expect(progress.delivered).toEqual(["wecom:0", "telegram:0", "telegram:1"]);
    wecom.send.mockImplementation(async () => {});
    await notifier.send(["first", "second"], progress);
    expect(telegram.send.mock.calls).toHaveLength(2);
    expect(wecom.send).toHaveBeenLastCalledWith(["second"]);
    expect(progress.checkpoint).toHaveBeenCalledTimes(4);
  });

  it("skips a pending recipient explicitly disabled in config", async () => {
    const notifier = new CompositeNotifier([
      { id: "new", notifier: { send: vi.fn() } },
    ]);
    await expect(
      notifier.send(["body"], {
        channels: ["old"],
        delivered: [],
        checkpoint: vi.fn(),
      }),
    ).resolves.toBeUndefined();
  });

  it("attaches bounded timeouts to both notification transports", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        return jsonResponse({ ok: true, errcode: 0 });
      },
    );
    await new TelegramNotifier("key", "123", fetcher).send(["hello"]);
    await new WeComNotifier("https://wecom.example", fetcher).send(["hello"]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
