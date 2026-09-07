import { describe, expect, it } from "vitest";
import { selectTargetComponent, statusLabel } from "../src/domain/component";
import { collectIncidentChanges } from "../src/domain/incidents";
import {
  buildNotificationParts,
  buildCurrentStatusReply,
  utf8Length,
} from "../src/domain/message";
import { component, currentIncident as incident } from "./helpers";

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
  it("ignores body edits without a timestamp change", () => {
    const first = incident("Initial body");
    const revised = incident("Revised body");
    const baseline = collectIncidentChanges([first], {});
    expect(
      collectIncidentChanges([revised], baseline.activeIncidents).events,
    ).toEqual([]);
  });

  it("tracks one timestamp per active incident and removes disappeared incidents silently", () => {
    const first = incident("Initial body");
    const initial = collectIncidentChanges([first], {});
    const revised = incident("Revised body", "2026-09-06T03:00:00.000Z");
    const changes = collectIncidentChanges([revised], initial.activeIncidents);
    expect(changes.events).toHaveLength(1);
    expect(changes.activeIncidents).toEqual({
      "incident-1": "2026-09-06T03:00:00.000Z",
    });
    const recovery = collectIncidentChanges([], changes.activeIncidents);
    expect(recovery.events).toHaveLength(0);
    expect(recovery.activeIncidents).toEqual({});
  });
});

describe("message formatting", () => {
  const current = {
    ok: true as const,
    checkedAt: "2026-09-06T03:00:00.000Z",
    component: {
      id: "codex-api-id",
      name: "Codex API",
      status: "operational",
      updatedAt: null,
    },
    incidents: [],
    incidentFeedDegraded: false,
  };

  it("keeps the healthy query to status and time only", () => {
    const reply = buildCurrentStatusReply(current, "Asia/Shanghai");
    expect(reply.split("\n")).toHaveLength(2);
    expect(reply).toContain("Codex API");
    expect(reply).toContain("正常");
    expect(reply).toContain("检测时间");
    expect(reply).not.toMatch(
      /实时检查完成|查询结果|不更新|不触发|baseline|committed|只读/,
    );
  });

  it("shows unavailable incident details without claiming recovery", () => {
    const reply = buildCurrentStatusReply(
      {
        ...current,
        component: { ...current.component, status: "major_outage" },
        incidentFeedDegraded: true,
      },
      "Asia/Shanghai",
    );
    expect(reply).toContain("严重中断");
    expect(reply).toContain("当前事件详情暂不可用");
  });

  it("shows translated and original current incident content", () => {
    const reply = buildCurrentStatusReply(
      {
        ...current,
        component: { ...current.component, status: "major_outage" },
        incidents: [
          {
            ...incident(),
            translatedName: "错误",
            translatedMessage: "部分请求失败",
          },
        ],
      },
      "Asia/Shanghai",
    );
    expect(reply).toContain("部分请求失败");
    expect(reply).toContain("Errors");
    expect(reply).toContain("官方原文");
    expect(reply).not.toMatch(
      /实时检查完成|查询结果|不更新|不触发|baseline|committed|只读/,
    );
  });

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
