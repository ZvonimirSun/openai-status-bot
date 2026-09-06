import { beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAIStatusClient } from "../src/clients/openai-status";
import { CompositeNotifier, type Notifier } from "../src/clients/notifiers";
import { TranslationClient } from "../src/clients/translation-client";
import { loadConfig } from "../src/config";
import {
  MonitorStateRepository,
  STATE_KEY,
} from "../src/repositories/monitor-state";
import { MonitorService } from "../src/services/monitor";
import type { Env } from "../src/types";
import { component, incident, jsonResponse, MemoryKv } from "./helpers";

describe("MonitorService", () => {
  let kv: MemoryKv;
  let sent: string[][];
  let notifier: Notifier;

  beforeEach(() => {
    kv = new MemoryKv();
    sent = [];
    notifier = {
      send: vi.fn(async (parts: string[]) => void sent.push(parts)),
    };
  });

  it("advances the baseline without notifications or translation when channels are disabled", async () => {
    const disabled = new CompositeNotifier([]);
    const translator = new TranslationClient({
      baseUrl: "https://example.com",
      apiKey: "key",
      model: "model",
      style: "chat-completions",
    });
    const translate = vi.spyOn(translator, "translate");
    await createService(kv, disabled, "operational", [], translator).run(
      "cron",
    );
    const result = await createService(
      kv,
      disabled,
      "major_outage",
      [incident()],
      translator,
    ).run("cron");
    expect(result.notified).toBe(false);
    expect(result.committed).toBe(true);
    expect(translate).not.toHaveBeenCalled();
    expect(kv.values.size).toBe(1);
  });

  it("bootstraps without notification, then performs no write when unchanged", async () => {
    const service = createService(kv, notifier, "operational", [incident()]);
    const baseline = await service.run("cron");
    expect(baseline.reason).toBe("baseline");
    expect(sent).toHaveLength(0);
    expect(kv.puts).toBe(1);

    const unchanged = await service.run("cron");
    expect(unchanged.changed).toBe(false);
    expect(kv.puts).toBe(1);
  });

  it("fetches only components while healthy, including read-only checks", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL) =>
      jsonResponse({ components: [component()] }),
    );
    const translator = new TranslationClient({
      baseUrl: "https://example.com",
      apiKey: null,
      model: null,
      style: "chat-completions",
    });
    const service = new MonitorService(
      loadConfig({}),
      new OpenAIStatusClient(fetcher),
      new MonitorStateRepository(kv.asNamespace()),
      notifier,
      translator,
    );
    await service.run("cron");
    await service.run("cron");
    await service.run("admin-check");
    await service.run("telegram-check");
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(
      fetcher.mock.calls.every(([url]) =>
        String(url).includes("components.json"),
      ),
    ).toBe(true);
    expect(kv.puts).toBe(1);
    expect(JSON.parse(kv.values.get(STATE_KEY)!)).toMatchObject({
      activeIncidents: {},
    });
  });

  it("preserves active timestamps when the incident feed fails", async () => {
    await createService(kv, notifier, "major_outage", [incident()]).run("cron");
    const before = kv.values.get(STATE_KEY);
    const failed = await createService(kv, notifier, "major_outage", null).run(
      "cron",
    );
    expect(failed.incidentFeedDegraded).toBe(true);
    expect(kv.values.get(STATE_KEY)).toBe(before);
    await createService(kv, notifier, "major_outage", [incident()]).run("cron");
    expect(kv.puts).toBe(1);
    expect(sent).toHaveLength(0);
  });

  it("includes tracked resolution details once and clears active incidents", async () => {
    await createService(kv, notifier, "major_outage", [incident()]).run("cron");
    const closed = {
      ...incident("Recovered", "2026-09-06T03:00:00.000Z"),
      status: "resolved",
    };
    const result = await createService(kv, notifier, "operational", [
      closed,
    ]).run("cron");
    expect(result.events).toHaveLength(2);
    expect(result.events[1]).toMatchObject({ body: "Recovered" });
    expect(JSON.parse(kv.values.get(STATE_KEY)!).activeIncidents).toEqual({});
    const puts = kv.puts;
    await createService(kv, notifier, "operational", [closed]).run("cron");
    expect(kv.puts).toBe(puts);
    expect(sent).toHaveLength(1);
  });

  it("clears recovery state even when incident details are unavailable", async () => {
    await createService(kv, notifier, "major_outage", [incident()]).run("cron");
    const result = await createService(kv, notifier, "operational", null).run(
      "cron",
    );
    expect(result.notified).toBe(true);
    expect(result.events).toHaveLength(1);
    expect(JSON.parse(kv.values.get(STATE_KEY)!).activeIncidents).toEqual({});
  });

  it("removes disappeared events without sending a false recovery notification", async () => {
    await createService(kv, notifier, "major_outage", [incident()]).run("cron");
    const result = await createService(kv, notifier, "major_outage", []).run(
      "cron",
    );
    expect(result.changed).toBe(false);
    expect(result.committed).toBe(true);
    expect(sent).toHaveLength(0);
    expect(JSON.parse(kv.values.get(STATE_KEY)!).activeIncidents).toEqual({});
  });

  it("notifies and commits status degradation and recovery", async () => {
    await createService(kv, notifier, "operational", []).run("cron");
    const degraded = await createService(
      kv,
      notifier,
      "degraded_performance",
      [],
    ).run("cron");
    expect(degraded.notified).toBe(true);
    expect(degraded.committed).toBe(true);
    const recovered = await createService(kv, notifier, "operational", []).run(
      "cron",
    );
    expect(recovered.events[0]).toMatchObject({
      type: "component-status-changed",
      previousStatus: "degraded_performance",
      currentStatus: "operational",
    });
  });

  it("notifies when an active incident timestamp changes", async () => {
    await createService(kv, notifier, "major_outage", [
      incident("Initial"),
    ]).run("cron");
    const result = await createService(kv, notifier, "major_outage", [
      incident("Revised", "2026-09-06T03:00:00.000Z"),
    ]).run("cron");
    expect(result.events[0]).toMatchObject({
      type: "incident-update",
      body: "Revised",
    });
  });

  it("does not advance KV when notification fails", async () => {
    await createService(kv, notifier, "operational", []).run("cron");
    const before = kv.values.get(STATE_KEY);
    const failedNotifier: Notifier = {
      send: vi.fn(async () => Promise.reject(new Error("Telegram failed"))),
    };
    await expect(
      createService(kv, failedNotifier, "major_outage", []).run("cron"),
    ).rejects.toThrow("Telegram failed");
    expect(kv.values.get(STATE_KEY)).toBe(before);
  });

  it("reports current details after an initial feed failure without historical notifications", async () => {
    await createService(kv, notifier, "major_outage", null).run("cron");
    expect(JSON.parse(kv.values.get(STATE_KEY)!)).toMatchObject({
      activeIncidents: {},
    });
    const recovered = await createService(kv, notifier, "major_outage", [
      incident("Current"),
      { ...incident("Historical"), id: "closed", status: "resolved" },
    ]).run("cron");
    expect(recovered.changed).toBe(true);
    expect(recovered.committed).toBe(true);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(kv.values.get(STATE_KEY)!)).toMatchObject({
      activeIncidents: { "incident-1": "2026-09-06T02:05:00.000Z" },
    });
    await createService(kv, notifier, "major_outage", [
      incident("Current"),
    ]).run("cron");
    expect(sent).toHaveLength(1);
  });

  it.each(["admin-check", "telegram-check"] as const)(
    "keeps %s read-only and translates active incidents",
    async (trigger) => {
      await createService(kv, notifier, "operational", [incident()]).run(
        "cron",
      );
      const before = [...kv.values];
      const translator = new TranslationClient({
        baseUrl: "https://example.com",
        apiKey: "key",
        model: "model",
        style: "chat-completions",
      });
      vi.spyOn(translator, "translate").mockImplementation(async (events) =>
        events.map((event) => ({ ...event, translatedBody: "translated" })),
      );
      const result = await createService(
        kv,
        notifier,
        "degraded_performance",
        [incident()],
        translator,
      ).run(trigger);
      expect(result.notified).toBe(false);
      expect(result.committed).toBe(false);
      expect(result.events).toContainEqual(
        expect.objectContaining({ translatedBody: "translated" }),
      );
      expect([...kv.values]).toEqual(before);
      expect(sent).toHaveLength(0);
      expect(translator.translate).toHaveBeenCalledTimes(1);
    },
  );

  it("does not initialize a baseline during an admin query", async () => {
    const result = await createService(kv, notifier, "operational", []).run(
      "admin-check",
    );
    expect(result.committed).toBe(false);
    expect(result.notified).toBe(false);
    expect(kv.puts).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("persists partial receipts and reuses the translated batch after a restart", async () => {
    await createService(kv, notifier, "operational", []).run("cron");
    const telegram = { send: vi.fn(async () => {}) };
    const wecom = {
      send: vi.fn(async (): Promise<void> => {
        throw new Error("down");
      }),
    };
    const composite = new CompositeNotifier([
      { id: "telegram", notifier: telegram },
      { id: "wecom", notifier: wecom },
    ]);
    const translator = new TranslationClient({
      baseUrl: "https://example.com",
      apiKey: null,
      model: null,
      style: "chat-completions",
    });
    const translate = vi.spyOn(translator, "translate");
    await expect(
      createService(
        kv,
        composite,
        "major_outage",
        [incident()],
        translator,
      ).run("cron"),
    ).rejects.toThrow("incomplete");
    expect(telegram.send).toHaveBeenCalledTimes(1);
    wecom.send.mockImplementation(async () => {});
    await createService(
      kv,
      composite,
      "major_outage",
      [incident()],
      translator,
    ).run("cron");
    expect(telegram.send).toHaveBeenCalledTimes(1);
    expect(wecom.send).toHaveBeenCalledTimes(2);
    expect(translate).toHaveBeenCalledTimes(1);
    const puts = kv.puts;
    await createService(
      kv,
      composite,
      "major_outage",
      [incident()],
      translator,
    ).run("cron");
    expect(kv.puts).toBe(puts);
  });
});

function createService(
  kv: MemoryKv,
  notifier: Notifier,
  status: string,
  incidents: ReturnType<typeof incident>[] | null,
  translator?: TranslationClient,
): MonitorService {
  const fetcher = vi.fn(async (input: RequestInfo | URL) =>
    String(input).includes("components")
      ? jsonResponse({ components: [component(status)] })
      : jsonResponse({ incidents }),
  );
  const env: Env = { STATUS_KV: kv.asNamespace() };
  return new MonitorService(
    loadConfig(env),
    new OpenAIStatusClient(fetcher as typeof fetch),
    new MonitorStateRepository(kv.asNamespace()),
    notifier,
    translator ??
      new TranslationClient({
        baseUrl: "https://api.deepseek.com",
        apiKey: null,
        model: null,
        style: "chat-completions",
      }),
    () => new Date("2026-09-06T03:00:00.000Z"),
  );
}
