import { describe, expect, it } from "vitest";
import { selectTargetComponent, statusLabel } from "../src/domain/component";
import {
  collectIncidentChanges,
  isRelevantIncident,
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

  it("ignores body edits without a timestamp change", () => {
    const first = incident("Initial body");
    const revised = incident("Revised body");
    const baseline = collectIncidentChanges([first], "balanced", {});
    expect(
      collectIncidentChanges([revised], "balanced", baseline.activeIncidents)
        .events,
    ).toEqual([]);
  });

  it("tracks one timestamp per active incident and removes closed history", () => {
    const first = incident("Initial body");
    const initial = collectIncidentChanges([first], "balanced", {});
    const revised = incident("Revised body", "2026-09-06T03:00:00.000Z");
    const changes = collectIncidentChanges(
      [revised],
      "balanced",
      initial.activeIncidents,
    );
    expect(changes.events).toHaveLength(1);
    expect(changes.activeIncidents).toEqual({
      "incident-1": "2026-09-06T03:00:00.000Z",
    });
    const closed = {
      ...incident("Recovered", "2026-09-06T04:00:00.000Z"),
      status: "resolved",
    };
    const recovery = collectIncidentChanges(
      [closed],
      "balanced",
      changes.activeIncidents,
      true,
    );
    expect(recovery.events).toHaveLength(1);
    expect(recovery.activeIncidents).toEqual({});
    expect(collectIncidentChanges([closed], "balanced", {}).events).toEqual([]);
  });

  it("uses incident updated_at and reports only the latest update", () => {
    const current = { ...incident(), updated_at: "2026-09-06T05:00:00.000Z" };
    current.incident_updates.push(
      ...incident("Latest", "2026-09-06T04:00:00.000Z").incident_updates,
    );
    const result = collectIncidentChanges([current], "balanced", {});
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.body).toBe("Latest");
    expect(result.activeIncidents[current.id]).toBe(current.updated_at);
    expect(
      collectIncidentChanges([], "balanced", result.activeIncidents)
        .activeIncidents,
    ).toEqual({});
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
