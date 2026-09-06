import type { Env, IncidentMatchMode } from "./types";

export interface AppConfig {
  targetComponentName: string;
  incidentMatchMode: IncidentMatchMode;
  displayTimeZone: string;
  incidentLookbackDays: number;
  notifyOnBootstrap: boolean;
  adminToken: string | null;
  translationApiBaseUrl: string;
  translationApiKey: string | null;
  translationModel: string | null;
  translationApiStyle: "chat-completions" | "responses";
}

export function loadConfig(env: Env): AppConfig {
  return {
    targetComponentName: env.TARGET_COMPONENT_NAME?.trim() || "Codex API",
    incidentMatchMode: parseMatchMode(env.INCIDENT_MATCH_MODE),
    displayTimeZone: env.DISPLAY_TIME_ZONE?.trim() || "Asia/Shanghai",
    incidentLookbackDays: parsePositiveInteger(env.INCIDENT_LOOKBACK_DAYS, 30),
    notifyOnBootstrap: parseBoolean(env.NOTIFY_ON_BOOTSTRAP, false),
    adminToken: env.CHECK_TOKEN?.trim() || null,
    translationApiBaseUrl:
      env.TRANSLATION_API_BASE_URL?.trim() || "https://api.deepseek.com",
    translationApiKey: env.TRANSLATION_API_KEY?.trim() || null,
    translationModel: env.TRANSLATION_MODEL?.trim() || null,
    translationApiStyle:
      env.TRANSLATION_API_STYLE === "responses"
        ? "responses"
        : "chat-completions",
  };
}

export function resolveKv(env: Env): KVNamespace {
  const kv = env.STATUS_KV;
  if (!kv) throw new Error("STATUS_KV binding is required");
  return kv;
}

function parseMatchMode(value: string | undefined): IncidentMatchMode {
  return value === "strict" || value === "broad" || value === "balanced"
    ? value
    : "balanced";
}

function parsePositiveInteger(
  value: string | number | undefined,
  fallback: number,
): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolean(
  value: string | boolean | undefined,
  fallback: boolean,
): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}
