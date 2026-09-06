import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAIStatusClient } from "../src/clients/openai-status";
import { TranslationClient } from "../src/clients/translation-client";
import { TelegramNotifier, WeComNotifier } from "../src/clients/notifiers";
import worker, { runMonitor } from "../src/index";
import type { IncidentUpdateEvent } from "../src/types";
import { component, jsonResponse, MemoryKv } from "./helpers";

describe("Workers fetch receiver", () => {
  afterEach(() => vi.unstubAllGlobals());

  function receiverCheckedFetch() {
    return vi.fn(async function (this: unknown, input: RequestInfo | URL) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      const url = String(input);
      if (url.includes("components.json"))
        return jsonResponse({ components: [component()] });
      if (url.includes("incidents.json"))
        return jsonResponse({ incidents: [] });
      if (url.includes("chat/completions"))
        return jsonResponse({
          choices: [
            {
              message: {
                content: JSON.stringify([
                  { index: 0, title: "translated", body: "translated" },
                ]),
              },
            },
          ],
        });
      return jsonResponse({ ok: true, errcode: 0 });
    });
  }

  it("preserves the global receiver for every external client", async () => {
    const fetcher = receiverCheckedFetch();
    vi.stubGlobal("fetch", fetcher);
    expect(
      (await new OpenAIStatusClient().fetchSnapshot()).components,
    ).toHaveLength(1);
    const event: IncidentUpdateEvent = {
      type: "incident-update",
      incidentId: "i",
      incidentName: "Codex API",
      incidentStatus: "investigating",
      updateId: "u",
      updateStatus: "investigating",
      body: "Errors",
      eventAt: new Date().toISOString(),
      shortlink: null,
      revised: false,
    };
    const result = await new TranslationClient({
      baseUrl: "https://translation.example",
      apiKey: "test",
      model: "test",
      style: "chat-completions",
    }).translate([event]);
    expect(result[0]).toMatchObject({ translatedBody: "translated" });
    await new TelegramNotifier("test", "123").send(["test"]);
    await new WeComNotifier("https://wecom.example").send(["test"]);
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it("writes the cron baseline and replies to /check with a native-like fetch", async () => {
    const fetcher = receiverCheckedFetch();
    vi.stubGlobal("fetch", fetcher);
    const kv = new MemoryKv();
    const env = {
      STATUS_KV: kv.asNamespace(),
      TELEGRAM_BOT_TOKEN: "test",
      TELEGRAM_CHAT_ID: "123",
      TELEGRAM_WEBHOOK_SECRET: "secret",
    };
    const baseline = await runMonitor(env, "cron");
    expect(baseline.committed).toBe(true);
    expect(kv.puts).toBe(1);
    const response = await worker.fetch(
      new Request("https://example.com/telegram/webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Telegram-Bot-Api-Secret-Token": "secret",
        },
        body: JSON.stringify({
          message: { chat: { id: 123 }, text: "/check" },
        }),
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(kv.puts).toBe(1);
    expect(
      fetcher.mock.calls.filter(([url]) =>
        String(url).includes("api.telegram.org"),
      ),
    ).toHaveLength(1);
  });
});
