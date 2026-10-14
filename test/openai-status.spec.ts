import { describe, expect, it, vi } from "vitest";
import { OpenAIStatusClient } from "../src/clients/openai-status";
import { incident, jsonResponse } from "./helpers";

function client(ongoing: unknown) {
  return new OpenAIStatusClient(
    vi.fn(async () =>
      jsonResponse({ summary: { ongoing_incidents: ongoing } }),
    ),
  );
}

describe("Widget component associations", () => {
  it("includes arbitrary titles by exact affected component ID, never keywords", async () => {
    const results = await client([
      { ...incident(), name: "Elevated errors across services" },
      {
        ...incident(),
        id: "web",
        name: "Codex API errors",
        affected_components: [{ component_id: "codex-web-id" }],
      },
      { ...incident(), id: "missing", affected_components: undefined },
    ]).fetchRelevantIncidents("codex-api-id");
    expect(results.map((entry) => entry.id)).toEqual(["incident-1"]);
  });

  it("accepts component impacts and incidents affecting multiple components", async () => {
    const results = await client([
      {
        ...incident(),
        affected_components: [],
        component_impacts: [{ component_id: "codex-api-id" }],
      },
      {
        ...incident(),
        id: "multi",
        affected_components: [
          { component_id: "web" },
          { component_id: "codex-api-id" },
        ],
      },
    ]).fetchRelevantIncidents("codex-api-id");
    expect(results).toHaveLength(2);
  });

  it("normalizes the native website updates schema using its newest published update", async () => {
    const results = await client([
      {
        id: "01M0G1RZER839AZXWMYKSZF3GR",
        name: "Elevated Codex API authentication errors",
        status: "monitoring",
        affected_components: [{ component_id: "01KMP3KP5MGE23B80K1EK4S8PV" }],
        updates: [
          {
            published_at: "2026-08-20T17:15:51.764Z",
            message: {
              markdown:
                "We have applied the mitigation and are monitoring the recovery.",
            },
          },
          {
            published_at: "2026-08-20T16:58:53.272Z",
            message_string:
              "Some users may encounter errors when using Codex with API authentication.",
          },
        ],
      },
    ]).fetchRelevantIncidents("01KMP3KP5MGE23B80K1EK4S8PV");
    expect(results[0]).toMatchObject({
      lastUpdateAt: "2026-08-20T17:15:51.764Z",
      message:
        "We have applied the mitigation and are monitoring the recovery.",
      url: "https://status.openai.com/incidents/01M0G1RZER839AZXWMYKSZF3GR",
    });
  });

  it("accepts an empty ongoing list", async () => {
    expect(await client([]).fetchRelevantIncidents("codex-api-id")).toEqual([]);
  });

  it("uses Codex keywords as a fallback in titles and latest messages", async () => {
    const results = await client([
      {
        ...incident(),
        id: "title",
        name: "Elevated CODEX errors",
        affected_components: [],
      },
      {
        ...incident(),
        id: "body",
        name: "Elevated errors",
        last_update_message: "Codex users may see errors",
        affected_components: [],
      },
      {
        ...incident(),
        id: "other",
        name: "ChatGPT errors",
        last_update_message: "ChatGPT unavailable",
        affected_components: [],
      },
      { ...incident(), id: "resolved", status: "resolved" },
    ]).fetchRelevantIncidents(["desktop-id", "codex-api-id"], ["web-id"], true);
    expect(results.map((entry) => entry.id)).toEqual(["title", "body"]);
  });

  it("excludes Web-only incidents but retains incidents also affecting Desktop or API", async () => {
    const results = await client([
      {
        ...incident(),
        id: "web",
        name: "Codex errors",
        affected_components: [{ component_id: "web-id" }],
      },
      {
        ...incident(),
        id: "multi",
        name: "Codex Web errors",
        affected_components: [
          { component_id: "web-id" },
          { component_id: "desktop-id" },
        ],
      },
      {
        ...incident(),
        id: "cloud",
        name: "Codex cloud tasks failing",
        last_update_message: "Cloud tasks are unavailable",
        affected_components: [],
      },
      { ...incident(), id: "api", name: "Service errors" },
      {
        ...incident(),
        id: "impact-web",
        affected_components: [],
        component_impacts: [{ component_id: "web-id" }],
      },
    ]).fetchRelevantIncidents(["desktop-id", "codex-api-id"], ["web-id"], true);
    expect(results.map((entry) => entry.id)).toEqual(["multi", "api"]);
  });

  it.each([
    null,
    [null],
    [{ ...incident(), affected_components: {} }],
    [{ ...incident(), last_update_at: "invalid" }],
    [{ ...incident(), last_update_message: null }],
    [{ ...incident(), url: "javascript:alert(1)" }],
    [incident(), incident()],
    [
      {
        ...incident(),
        last_update_at: undefined,
        last_update_message: undefined,
        updates: [],
      },
    ],
  ])("rejects malformed Widget payload %j", async (payload) => {
    await expect(
      client(payload).fetchRelevantIncidents("codex-api-id"),
    ).rejects.toThrow("Invalid");
  });

  it("rejects a missing summary instead of treating the feed as empty", async () => {
    await expect(
      new OpenAIStatusClient(async () =>
        jsonResponse({}),
      ).fetchRelevantIncidents("codex-api-id"),
    ).rejects.toThrow("summary");
  });
});
