import { describe, expect, it } from "vitest";
import { selectTargetComponent, statusLabel } from "../src/domain/component";
import {
  collectIncidentChanges,
  fingerprintUpdate,
  isRelevantIncident,
  pruneRevisions,
} from "../src/domain/incidents";
import { buildNotificationParts, utf8Length } from "../src/domain/message";
import { component, incident } from "./helpers";

describe("component selection", () => {
  it("selects only the exact Codex API component", () => {
    const target = selectTargetComponent(
      [
        { ...component("major_outage"), id: "responses", name: "Responses" },
        component("operational"),
        { ...component("major_outage"), id: "web", name: "Codex Web" },
      ],
      "Codex API",
    );
    expect(target.status).toBe("operational");
  });

  it("maps known and unknown labels", () => {
    expect(statusLabel("major_outage")).toBe("严重中断");
    expect(statusLabel("new_status")).toContain("new_status");
  });
});

describe("incident matching and revisions", () => {
  it("supports strict, balanced and broad matching", () => {
    const api = incident("Codex API requests are failing");
    const cloud = {
      ...incident("Codex Cloud tasks are delayed"),
      name: "Codex Cloud delays",
    };
    const general = {
      ...incident("Elevated errors across ChatGPT and Codex"),
      name: "Elevated errors",
    };
    expect(isRelevantIncident(api, "strict")).toBe(true);
    expect(isRelevantIncident(cloud, "balanced")).toBe(false);
    expect(isRelevantIncident(cloud, "broad")).toBe(true);
    expect(isRelevantIncident(general, "balanced")).toBe(true);
  });

  it("changes the fingerprint when an update is revised", async () => {
    const first = incident("Initial body");
    const revised = incident("Revised body");
    expect(await fingerprintUpdate(first, first.incident_updates[0]!)).not.toBe(
      await fingerprintUpdate(revised, revised.incident_updates[0]!),
    );
  });

  it("detects a revision and prunes old/excess records", async () => {
    const now = new Date("2026-09-06T03:00:00.000Z");
    const first = incident("Initial body");
    const initial = await collectIncidentChanges(
      [first],
      "balanced",
      {},
      now,
      30,
    );
    const revised = incident("Revised body");
    const changes = await collectIncidentChanges(
      [revised],
      "balanced",
      initial.revisions,
      now,
      30,
    );
    expect(changes.events).toHaveLength(1);
    expect(changes.events[0]?.revised).toBe(true);
    expect(
      pruneRevisions(
        {
          old: { fingerprint: "old", eventAt: "2025-01-01T00:00:00.000Z" },
          current: { fingerprint: "current", eventAt: now.toISOString() },
        },
        now,
        30,
        1,
      ),
    ).toEqual({
      current: { fingerprint: "current", eventAt: now.toISOString() },
    });
  });
});

describe("message formatting", () => {
  it("chunks by UTF-8 byte length without splitting an event arbitrarily", () => {
    const event = {
      type: "incident-update" as const,
      incidentId: "incident-1",
      incidentName: "Codex API errors",
      incidentStatus: "investigating",
      updateId: "update-1",
      updateStatus: "investigating",
      body: "中文🙂".repeat(1500),
      eventAt: "2026-09-06T02:00:00.000Z",
      shortlink: null,
      revised: false,
    };
    const parts = buildNotificationParts(
      [event, { ...event, updateId: "update-2" }],
      "degraded_performance",
      "2026-09-06T03:00:00.000Z",
      "Asia/Shanghai",
    );
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => utf8Length(part) < 3600)).toBe(true);
    expect(parts.join("\n")).toContain("正文过长");
  });
});
