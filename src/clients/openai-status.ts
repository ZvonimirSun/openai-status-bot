import type {
  CurrentIncident,
  StatusComponent,
  WidgetAffectedComponent,
} from "../types";

const COMPONENTS_URL = "https://status.openai.com/api/v2/components.json";
const WIDGET_URL = "https://status.openai.com/proxy/status.openai.com";
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export class OpenAIStatusClient {
  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly signal?: AbortSignal,
  ) {}

  async fetchComponents(): Promise<StatusComponent[]> {
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

  async fetchRelevantIncidents(
    componentId: string,
  ): Promise<CurrentIncident[]> {
    const payload = await this.fetchJson(WIDGET_URL);
    if (
      !isRecord(payload) ||
      !isRecord(payload.summary) ||
      !Array.isArray(payload.summary.ongoing_incidents)
    ) {
      throw new Error("Invalid OpenAI Widget summary");
    }
    const incidents: CurrentIncident[] = [];
    const ids = new Set<string>();
    for (const incident of payload.summary.ongoing_incidents) {
      if (!isRecord(incident))
        throw new Error("Invalid OpenAI Widget incident");
      const affected = readAffectedComponents(incident.affected_components);
      const impacts = readAffectedComponents(incident.component_impacts);
      if (
        ![...affected, ...impacts].some(
          (entry) => entry.component_id === componentId,
        )
      )
        continue;
      const current = toCurrentIncident(incident);
      if (ids.has(current.id))
        throw new Error("Invalid duplicate OpenAI Widget incident");
      ids.add(current.id);
      incidents.push(current);
    }
    return incidents;
  }

  private async fetchJson(url: string): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await this.fetcher.call(globalThis, url, {
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

function readAffectedComponents(value: unknown): WidgetAffectedComponent[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    !value.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.component_id === "string" &&
        entry.component_id.length > 0,
    )
  ) {
    throw new Error("Invalid OpenAI Widget component associations");
  }
  return value as WidgetAffectedComponent[];
}

function toCurrentIncident(value: Record<string, unknown>): CurrentIncident {
  if (
    typeof value.id !== "string" ||
    !value.id ||
    typeof value.name !== "string" ||
    typeof value.status !== "string"
  ) {
    throw new Error("Invalid OpenAI Widget incident identity");
  }
  let lastUpdateAt = value.last_update_at;
  let message = value.last_update_message;
  // The site's native schema carries updates instead of the compact fields.
  // Normalize both at the boundary; the monitor only sees the latest content.
  if (lastUpdateAt === undefined && message === undefined) {
    if (!Array.isArray(value.updates) || value.updates.length === 0)
      throw new Error("Invalid OpenAI Widget updates");
    const updates = value.updates
      .map((update: unknown) => {
        if (!isRecord(update) || !isTimestamp(update.published_at))
          throw new Error("Invalid OpenAI Widget update time");
        const body =
          update.message_string ??
          (isRecord(update.message) ? update.message.markdown : undefined);
        if (typeof body !== "string")
          throw new Error("Invalid OpenAI Widget update message");
        return { at: update.published_at, body };
      })
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    lastUpdateAt = updates[0]!.at;
    message = updates[0]!.body;
  }
  if (!isTimestamp(lastUpdateAt) || typeof message !== "string")
    throw new Error("Invalid OpenAI Widget latest update");
  const url =
    value.url ??
    `https://status.openai.com/incidents/${encodeURIComponent(value.id)}`;
  if (typeof url !== "string" || !isHttpsUrl(url))
    throw new Error("Invalid OpenAI Widget incident URL");
  return {
    id: value.id,
    name: value.name,
    status: value.status,
    lastUpdateAt,
    message,
    url,
  };
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
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
