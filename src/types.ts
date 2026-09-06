export type ComponentStatus =
  | "operational"
  | "degraded_performance"
  | "partial_outage"
  | "major_outage"
  | "under_maintenance";

export type IncidentMatchMode = "strict" | "balanced" | "broad";
export type RunTrigger = "cron" | "admin-check" | "telegram-check";

export interface StatusComponent {
  id: string;
  name: string;
  status: string;
  updated_at: string | null;
}

export interface IncidentUpdate {
  id: string;
  status: string;
  body: string;
  updated_at: string;
  created_at: string | null;
}

export interface StatusIncident {
  id: string;
  name: string;
  status: string;
  shortlink: string | null;
  incident_updates: IncidentUpdate[];
}

export interface MonitorStateV1 {
  schemaVersion: 1;
  initializedAt: string;
  incidentsInitialized: boolean;
  lastNotificationId?: string;
  component: {
    id: string;
    name: string;
    status: string;
    updatedAt: string | null;
  };
  incidentRevisions: Record<string, IncidentRevisionRecord>;
}

export interface IncidentRevisionRecord {
  fingerprint: string;
  eventAt: string;
}

export interface ComponentStatusChangedEvent {
  type: "component-status-changed";
  previousStatus: string | null;
  currentStatus: string;
  componentId: string;
  componentName: string;
  componentUpdatedAt: string | null;
  observedAt: string;
}

export interface IncidentUpdateEvent {
  type: "incident-update";
  incidentId: string;
  incidentName: string;
  incidentStatus: string;
  updateId: string;
  updateStatus: string;
  body: string;
  eventAt: string;
  shortlink: string | null;
  revised: boolean;
  translatedIncidentName?: string;
  translatedBody?: string;
}

export type MonitorEvent = ComponentStatusChangedEvent | IncidentUpdateEvent;

export interface MonitorRunResult {
  ok: boolean;
  trigger: RunTrigger;
  bootstrap: boolean;
  changed: boolean;
  notified: boolean;
  committed: boolean;
  componentStatus: string | null;
  previousComponentStatus: string | null;
  events: MonitorEvent[];
  incidentFeedDegraded: boolean;
  messageParts: number;
  reason: string;
}

export interface Env {
  STATUS_KV?: KVNamespace;
  TARGET_COMPONENT_NAME?: string;
  INCIDENT_MATCH_MODE?: string;
  DISPLAY_TIME_ZONE?: string;
  INCIDENT_LOOKBACK_DAYS?: string | number;
  NOTIFY_ON_BOOTSTRAP?: string | boolean;
  WECOM_WEBHOOK_URL?: string;
  CHECK_TOKEN?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  TRANSLATION_API_BASE_URL?: string;
  TRANSLATION_API_KEY?: string;
  TRANSLATION_MODEL?: string;
  TRANSLATION_API_STYLE?: string;
}
