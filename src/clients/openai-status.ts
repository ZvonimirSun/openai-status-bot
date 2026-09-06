import type { IncidentUpdate, StatusComponent, StatusIncident } from "../types";

const COMPONENTS_URL = "https://status.openai.com/api/v2/components.json";
const INCIDENTS_URL = "https://status.openai.com/api/v2/incidents.json";
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export interface StatusSnapshot {
  components: StatusComponent[];
  incidents: StatusIncident[] | null;
  incidentFeedDegraded: boolean;
}

export class OpenAIStatusClient {
  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly signal?: AbortSignal,
  ) {}

  async fetchSnapshot(): Promise<StatusSnapshot> {
    const [componentsResult, incidentsResult] = await Promise.allSettled([
      this.fetchComponents(),
      this.fetchIncidents(),
    ]);
    if (componentsResult.status === "rejected") throw componentsResult.reason;
    if (incidentsResult.status === "rejected") {
      console.warn(
        JSON.stringify({ source: "openai-incidents", result: "degraded" }),
      );
      return {
        components: componentsResult.value,
        incidents: null,
        incidentFeedDegraded: true,
      };
    }
    return {
      components: componentsResult.value,
      incidents: incidentsResult.value,
      incidentFeedDegraded: false,
    };
  }

  private async fetchComponents(): Promise<StatusComponent[]> {
    const payload = await this.fetchJson(COMPONENTS_URL);
    if (!isRecord(payload) || !Array.isArray(payload.components)) {
      throw new Error("Invalid OpenAI components response");
    }
    const components = payload.components.filter(isStatusComponent);
    if (components.length !== payload.components.length) {
      throw new Error("Invalid component entry in OpenAI response");
    }
    return components;
  }

  private async fetchIncidents(): Promise<StatusIncident[]> {
    const payload = await this.fetchJson(INCIDENTS_URL);
    if (!isRecord(payload) || !Array.isArray(payload.incidents)) {
      throw new Error("Invalid OpenAI incidents response");
    }
    const incidents = payload.incidents.filter(isStatusIncident);
    if (incidents.length !== payload.incidents.length) {
      throw new Error("Invalid incident entry in OpenAI response");
    }
    return incidents;
  }

  private async fetchJson(url: string): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await this.fetcher(url, {
          headers: {
            Accept: "application/json",
            "User-Agent": "openai-codex-status-worker/1.0",
          },
          signal: this.signal
            ? AbortSignal.any([this.signal, AbortSignal.timeout(10_000)])
            : AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
          const retryable = response.status === 429 || response.status >= 500;
          if (!retryable || attempt === 2) {
            throw new Error(`${url} returned HTTP ${response.status}`);
          }
          lastError = new Error(`${url} returned HTTP ${response.status}`);
        } else {
          const declaredLength = Number(response.headers.get("content-length"));
          if (
            Number.isFinite(declaredLength) &&
            declaredLength > MAX_RESPONSE_BYTES
          ) {
            throw new Error(`${url} response exceeds size limit`);
          }
          const bytes = await response.arrayBuffer();
          if (bytes.byteLength > MAX_RESPONSE_BYTES) {
            throw new Error(`${url} response exceeds size limit`);
          }
          return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
        }
      } catch (error) {
        lastError = error;
        if (this.signal?.aborted) throw error;
        if (attempt === 2 || !isRetryableNetworkError(error)) throw error;
      }
      await delay(100 * 2 ** attempt + Math.floor(Math.random() * 100));
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("OpenAI status request failed");
  }
}

function isStatusComponent(value: unknown): value is StatusComponent {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.status === "string" &&
    (typeof value.updated_at === "string" ||
      value.updated_at === null ||
      value.updated_at === undefined)
  );
}

function isStatusIncident(value: unknown): value is StatusIncident {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.status !== "string"
  ) {
    return false;
  }
  if (
    !Array.isArray(value.incident_updates) ||
    !value.incident_updates.every(isIncidentUpdate)
  ) {
    return false;
  }
  return (
    typeof value.shortlink === "string" ||
    value.shortlink === null ||
    value.shortlink === undefined
  );
}

function isIncidentUpdate(value: unknown): value is IncidentUpdate {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.status === "string" &&
    typeof value.body === "string" &&
    typeof value.updated_at === "string" &&
    (typeof value.created_at === "string" ||
      value.created_at === null ||
      value.created_at === undefined)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRetryableNetworkError(error: unknown): boolean {
  if (error instanceof SyntaxError) return false;
  const message = error instanceof Error ? error.message : String(error);
  return (
    !message.includes("returned HTTP 4") &&
    !message.includes("size limit") &&
    !message.includes("Invalid")
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
