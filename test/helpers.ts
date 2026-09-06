import type { StatusComponent, StatusIncident } from "../src/types";

export class MemoryKv {
  readonly values = new Map<string, string>();
  puts = 0;

  async get<T = unknown>(
    key: string,
    type?: string | object,
  ): Promise<T | string | null> {
    const value = this.values.get(key);
    if (value === undefined) return null;
    return type === "json" || (typeof type === "object" && type !== null)
      ? (JSON.parse(value) as T)
      : value;
  }

  async put(key: string, value: string): Promise<void> {
    this.puts += 1;
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  asNamespace(): KVNamespace {
    return this as unknown as KVNamespace;
  }
}

export function component(status = "operational"): StatusComponent {
  return {
    id: "codex-api-id",
    name: "Codex API",
    status,
    updated_at: "2026-09-06T02:00:00.000Z",
  };
}

export function incident(
  body = "Elevated Codex API authentication errors",
  updatedAt = "2026-09-06T02:05:00.000Z",
): StatusIncident {
  return {
    id: "incident-1",
    name: "Codex API errors",
    status: "investigating",
    shortlink: "https://status.openai.com/incidents/1",
    incident_updates: [
      {
        id: "update-1",
        status: "investigating",
        body,
        updated_at: updatedAt,
        created_at: updatedAt,
      },
    ],
  };
}

export function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
