import { describe, expect, it, vi } from "vitest";
import { TranslationClient } from "../src/clients/translation-client";
import { loadConfig } from "../src/config";
import type { Env, IncidentUpdateEvent } from "../src/types";
import { jsonResponse } from "./helpers";

const event: IncidentUpdateEvent = {
  type: "incident-update",
  incidentId: "incident-1",
  incidentName: "Elevated Codex API errors",
  incidentStatus: "investigating",
  updateId: "update-1",
  updateStatus: "investigating",
  body: "We are investigating elevated authentication errors.",
  eventAt: "2026-09-06T02:00:00.000Z",
  shortlink: null,
  revised: false,
};

describe("TranslationClient", () => {
  it.each([
    [0, 0],
    [-1, 0],
    [0, 2],
    [1, 2],
  ])("rejects invalid indexes %j", async (...indexes) => {
    const events = [event, { ...event, updateId: "update-2" }];
    const client = new TranslationClient(
      {
        baseUrl: "https://provider.example/v1",
        apiKey: "key",
        model: "model",
        style: "chat-completions",
      },
      vi.fn(async () =>
        jsonResponse({
          choices: [
            {
              message: {
                content: JSON.stringify(
                  indexes.map((index) => ({
                    index,
                    title: "title",
                    body: "body",
                  })),
                ),
              },
            },
          ],
        }),
      ),
    );
    expect(await client.translate(events)).toEqual(events);
  });

  it("maps valid out-of-order indexes to the correct event", async () => {
    const client = new TranslationClient(
      {
        baseUrl: "https://provider.example/v1/",
        apiKey: "key",
        model: "model",
        style: "chat-completions",
      },
      vi.fn(async () =>
        jsonResponse({
          choices: [
            {
              message: {
                content: JSON.stringify([
                  { index: 1, title: "second", body: "second" },
                  { index: 0, title: "first", body: "first" },
                ]),
              },
            },
          ],
        }),
      ),
    );
    const result = await client.translate([
      event,
      { ...event, updateId: "update-2" },
    ]);
    expect(result).toMatchObject([
      { translatedBody: "first" },
      { translatedBody: "second" },
    ]);
  });

  it("defaults the base URL and protocol style", () => {
    const config = loadConfig({} as Env);
    expect(config.translationApiBaseUrl).toBe("https://api.deepseek.com");
    expect(config.translationApiStyle).toBe("chat-completions");
    expect(config.translationApiKey).toBeNull();
    expect(config.translationModel).toBeNull();
  });

  it("adds Chinese translations while preserving official text", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({
                translations: [
                  {
                    index: 0,
                    title: "Codex API 错误率升高",
                    body: "我们正在调查身份验证错误率升高的问题。",
                  },
                ],
              }),
            },
          },
        ],
      }),
    );
    const translated = await new TranslationClient(
      {
        baseUrl: "https://provider.example/v1",
        apiKey: "key",
        model: "configured-model",
        style: "chat-completions",
      },
      fetcher as typeof fetch,
    ).translate([event]);
    expect(translated[0]).toMatchObject({
      incidentName: event.incidentName,
      body: event.body,
      translatedIncidentName: "Codex API 错误率升高",
      translatedBody: "我们正在调查身份验证错误率升高的问题。",
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://provider.example/v1/chat/completions",
      expect.any(Object),
    );
  });

  it("does not call the API unless key and model are configured", async () => {
    const fetcher = vi.fn();
    expect(
      await new TranslationClient(
        {
          baseUrl: "https://api.deepseek.com",
          apiKey: null,
          model: "configured-model",
          style: "chat-completions",
        },
        fetcher,
      ).translate([event]),
    ).toEqual([event]);
    expect(
      await new TranslationClient(
        {
          baseUrl: "https://api.deepseek.com",
          apiKey: "key",
          model: null,
          style: "chat-completions",
        },
        fetcher,
      ).translate([event]),
    ).toEqual([event]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("supports Responses-compatible providers", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({
        output_text: JSON.stringify([
          { index: 0, title: "中文标题", body: "中文正文" },
        ]),
      }),
    );
    const translated = await new TranslationClient(
      {
        baseUrl: "https://provider.example/v1",
        apiKey: "key",
        model: "configured-model",
        style: "responses",
      },
      fetcher as typeof fetch,
    ).translate([event]);
    expect(translated[0]).toMatchObject({ translatedBody: "中文正文" });
    expect(fetcher).toHaveBeenCalledWith(
      "https://provider.example/v1/responses",
      expect.any(Object),
    );
  });

  it("falls back to official text when translation fails", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ error: "failed" }, 500));
    expect(
      await new TranslationClient(
        {
          baseUrl: "https://provider.example/v1",
          apiKey: "key",
          model: "configured-model",
          style: "chat-completions",
        },
        fetcher as typeof fetch,
      ).translate([event]),
    ).toEqual([event]);
  });
});
