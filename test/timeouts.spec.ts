import { describe, expect, it, vi } from "vitest";
import { OpenAIStatusClient } from "../src/clients/openai-status";
import { TranslationClient } from "../src/clients/translation-client";
import type { IncidentUpdateEvent } from "../src/types";

describe("shared request budget", () => {
  it("stops status retries when the overall query budget expires", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn(
      async (
        _input: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> => {
        init?.signal?.throwIfAborted();
        throw new Error("Expected aborted request");
      },
    );
    await expect(
      new OpenAIStatusClient(fetcher, controller.signal).fetchComponents(),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("falls back immediately instead of starting a new translation time budget", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn(
      async (
        _input: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> => {
        init?.signal?.throwIfAborted();
        throw new Error("Expected aborted request");
      },
    );
    const events: IncidentUpdateEvent[] = [
      {
        type: "incident-update",
        incidentId: "1",
        incidentName: "Codex API",
        incidentStatus: "investigating",
        updateId: "1",
        updateStatus: "investigating",
        body: "Errors",
        eventAt: new Date().toISOString(),
        shortlink: null,
        revised: false,
      },
    ];
    const client = new TranslationClient(
      {
        baseUrl: "https://example.com",
        apiKey: "key",
        model: "model",
        style: "chat-completions",
      },
      fetcher,
      controller.signal,
    );
    expect(await client.translate(events)).toEqual(events);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
