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
    await createService(kv, disabled, "operational", [], translator).runCron();
    const result = await createService(
      kv,
      disabled,
      "major_outage",
      [incident()],
      translator,
    ).runCron();
    expect(result.notified).toBe(false);
    expect(result.committed).toBe(true);
    expect(translate).not.toHaveBeenCalled();
    expect(kv.values.size).toBe(1);
  });

  it("bootstraps without notification, then performs no write when unchanged", async () => {
    const service = createService(kv, notifier, "operational", [incident()]);
    const baseline = await service.runCron();
    expect(baseline.reason).toBe("baseline");
    expect(sent).toHaveLength(0);
    expect(kv.puts).toBe(1);

    const unchanged = await service.runCron();
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
    await service.runCron();
    await service.runCron();
    await service.checkCurrent();
    await service.checkCurrent();
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
    await createService(kv, notifier, "major_outage", [incident()]).runCron();
    const before = kv.values.get(STATE_KEY);
    const failed = await createService(
      kv,
      notifier,
      "major_outage",
      null,
    ).runCron();
    expect(failed.incidentFeedDegraded).toBe(true);
    expect(kv.values.get(STATE_KEY)).toBe(before);
    await createService(kv, notifier, "major_outage", [incident()]).runCron();
    expect(kv.puts).toBe(1);
    expect(sent).toHaveLength(0);
  });

  it("sends only component recovery and clears active incidents", async () => {
    await createService(kv, notifier, "major_outage", [incident()]).runCron();
    const closed = {
      ...incident("Recovered", "2026-09-06T03:00:00.000Z"),
      status: "resolved",
    };
    const result = await createService(kv, notifier, "operational", [
      closed,
    ]).runCron();
    expect(result.events).toHaveLength(1);
    expect(sent.flat().join("\n")).not.toContain("Recovered");
    expect(JSON.parse(kv.values.get(STATE_KEY)!).activeIncidents).toEqual({});
    const puts = kv.puts;
    await createService(kv, notifier, "operational", [closed]).runCron();
    expect(kv.puts).toBe(puts);
    expect(sent).toHaveLength(1);
  });

  it("clears recovery state even when incident details are unavailable", async () => {
    await createService(kv, notifier, "major_outage", [incident()]).runCron();
    const result = await createService(
      kv,
      notifier,
      "operational",
      null,
    ).runCron();
    expect(result.notified).toBe(true);
    expect(result.events).toHaveLength(1);
    expect(JSON.parse(kv.values.get(STATE_KEY)!).activeIncidents).toEqual({});
  });

  it("removes disappeared events without sending a false recovery notification", async () => {
    await createService(kv, notifier, "major_outage", [incident()]).runCron();
    const result = await createService(
      kv,
      notifier,
      "major_outage",
      [],
    ).runCron();
    expect(result.changed).toBe(false);
    expect(result.committed).toBe(true);
    expect(sent).toHaveLength(0);
    expect(JSON.parse(kv.values.get(STATE_KEY)!).activeIncidents).toEqual({});
  });

  it("notifies and commits status degradation and recovery", async () => {
    await createService(kv, notifier, "operational", []).runCron();
    const degraded = await createService(
      kv,
      notifier,
      "degraded_performance",
      [],
    ).runCron();
    expect(degraded.notified).toBe(true);
    expect(degraded.committed).toBe(true);
    const recovered = await createService(
      kv,
      notifier,
      "operational",
      [],
    ).runCron();
    expect(recovered.events[0]).toMatchObject({
      type: "component-status-changed",
      previousStatus: "degraded_performance",
      currentStatus: "operational",
    });
  });

  it("notifies when an active incident timestamp changes", async () => {
    await createService(kv, notifier, "major_outage", [
      incident("Initial"),
    ]).runCron();
    const result = await createService(kv, notifier, "major_outage", [
      incident("Revised", "2026-09-06T03:00:00.000Z"),
    ]).runCron();
    expect(result.events[0]).toMatchObject({
      type: "incident-update",
      body: "Revised",
    });
  });

  it("notifies component changes during Widget failure and preserves known incidents", async () => {
    await createService(kv, notifier, "degraded_performance", [
      incident(),
    ]).runCron();
    const before = JSON.parse(kv.values.get(STATE_KEY)!).activeIncidents;
    const result = await createService(
      kv,
      notifier,
      "major_outage",
      null,
    ).runCron();
    expect(result.incidentFeedDegraded).toBe(true);
    expect(result.events).toHaveLength(1);
    expect(result.notified).toBe(true);
    expect(JSON.parse(kv.values.get(STATE_KEY)!).activeIncidents).toEqual(
      before,
    );
  });

  it("fetches neither Widget nor translation on recovery, and only notifies once", async () => {
    await createService(kv, notifier, "major_outage", [incident()]).runCron();
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain("components.json");
      return jsonResponse({ components: [component()] });
    });
    const translator = new TranslationClient({
      baseUrl: "https://example.com",
      apiKey: "key",
      model: "model",
      style: "chat-completions",
    });
    const translate = vi.spyOn(translator, "translate");
    const service = new MonitorService(
      loadConfig({}),
      new OpenAIStatusClient(fetcher),
      new MonitorStateRepository(kv.asNamespace()),
      notifier,
      translator,
    );
    const result = await service.runCron();
    await service.runCron();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(translate).not.toHaveBeenCalled();
    expect(result.events).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.join("\n")).toContain("已恢复");
    expect(JSON.parse(kv.values.get(STATE_KEY)!).activeIncidents).toEqual({});
  });

  it("translates and notifies new details once, then skips unchanged content", async () => {
    await createService(kv, notifier, "operational", []).runCron();
    const translator = new TranslationClient({
      baseUrl: "https://example.com",
      apiKey: "key",
      model: "model",
      style: "chat-completions",
    });
    const translate = vi
      .spyOn(translator, "translate")
      .mockImplementation(async (events) => events);
    const first = await createService(
      kv,
      notifier,
      "major_outage",
      [incident()],
      translator,
    ).runCron();
    expect(first.events.map((event) => event.type)).toEqual([
      "component-status-changed",
      "incident-update",
    ]);
    await createService(
      kv,
      notifier,
      "major_outage",
      [incident("Progress", "2026-09-06T04:00:00Z")],
      translator,
    ).runCron();
    const puts = kv.puts;
    await createService(
      kv,
      notifier,
      "major_outage",
      [incident("Progress", "2026-09-06T04:00:00Z")],
      translator,
    ).runCron();
    expect(translate).toHaveBeenCalledTimes(2);
    expect(sent).toHaveLength(2);
    expect(kv.puts).toBe(puts);
  });

  it.each([false, true])(
    "preserves explicit bootstrap notification setting %s",
    async (enabled) => {
      const fetcher = vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes("components.json")
          ? jsonResponse({ components: [component("major_outage")] })
          : jsonResponse({ summary: { ongoing_incidents: [incident()] } }),
      );
      const translator = new TranslationClient({
        baseUrl: "https://example.com",
        apiKey: null,
        model: null,
        style: "chat-completions",
      });
      const service = new MonitorService(
        loadConfig({ NOTIFY_ON_BOOTSTRAP: enabled }),
        new OpenAIStatusClient(fetcher),
        new MonitorStateRepository(kv.asNamespace()),
        notifier,
        translator,
      );
      const result = await service.runCron();
      expect(result.bootstrap).toBe(true);
      expect(result.notified).toBe(enabled);
      expect(sent).toHaveLength(enabled ? 1 : 0);
      expect(
        JSON.parse(kv.values.get(STATE_KEY)!).activeIncidents,
      ).toHaveProperty("incident-1");
    },
  );

  it("does not advance KV when notification fails", async () => {
    await createService(kv, notifier, "operational", []).runCron();
    const before = kv.values.get(STATE_KEY);
    const failedNotifier: Notifier = {
      send: vi.fn(async () => Promise.reject(new Error("Telegram failed"))),
    };
    await expect(
      createService(kv, failedNotifier, "major_outage", []).runCron(),
    ).rejects.toThrow("Telegram failed");
    expect(kv.values.get(STATE_KEY)).toBe(before);
  });

  it("reports current details after an initial feed failure without historical notifications", async () => {
    await createService(kv, notifier, "major_outage", null).runCron();
    expect(JSON.parse(kv.values.get(STATE_KEY)!)).toMatchObject({
      activeIncidents: {},
    });
    const recovered = await createService(kv, notifier, "major_outage", [
      incident("Current"),
    ]).runCron();
    expect(recovered.changed).toBe(true);
    expect(recovered.committed).toBe(true);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(kv.values.get(STATE_KEY)!)).toMatchObject({
      activeIncidents: { "incident-1": "2026-09-06T02:05:00.000Z" },
    });
    await createService(kv, notifier, "major_outage", [
      incident("Current"),
    ]).runCron();
    expect(sent).toHaveLength(1);
  });

  it.each(["admin-check", "telegram-check"] as const)(
    "keeps %s read-only and translates active incidents",
    async (trigger) => {
      await createService(kv, notifier, "operational", [incident()]).runCron();
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
      ).checkCurrent();
      expect(result).not.toHaveProperty("notified");
      expect(result).not.toHaveProperty("committed");
      expect(result.incidents).toContainEqual(
        expect.objectContaining({ translatedMessage: "translated" }),
      );
      expect([...kv.values]).toEqual(before);
      expect(sent).toHaveLength(0);
      expect(translator.translate).toHaveBeenCalledTimes(1);
    },
  );

  it("does not initialize a baseline during an admin query", async () => {
    const result = await createService(
      kv,
      notifier,
      "operational",
      [],
    ).checkCurrent();
    expect(result).not.toHaveProperty("committed");
    expect(result).not.toHaveProperty("notified");
    expect(kv.gets).toBe(0);
    expect(kv.puts).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("persists partial receipts and reuses the translated batch after a restart", async () => {
    await createService(kv, notifier, "operational", []).runCron();
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
      ).runCron(),
    ).rejects.toThrow("incomplete");
    expect(telegram.send).toHaveBeenCalledTimes(1);
    wecom.send.mockImplementation(async () => {});
    await createService(
      kv,
      composite,
      "major_outage",
      [incident()],
      translator,
    ).runCron();
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
    ).runCron();
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
      : jsonResponse({ summary: { ongoing_incidents: incidents } }),
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
