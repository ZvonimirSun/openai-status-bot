export type ComponentStatus =
  | "operational"
  | "degraded_performance"
  | "partial_outage"
  | "major_outage"
  | "under_maintenance";

export interface StatusComponent {
  id: string;
  name: string;
  status: string;
  updated_at: string | null;
}

export interface WidgetAffectedComponent {
  component_id: string;
}

export interface WidgetIncident {
  id: string;
  name: string;
  status: string;
  url?: string | null;
  last_update_at?: string;
  last_update_message?: string;
  affected_components?: WidgetAffectedComponent[];
  component_impacts?: WidgetAffectedComponent[];
  updates?: {
    published_at: string;
    message_string?: string;
    message?: { markdown: string };
  }[];
}

export interface CurrentIncident {
  id: string;
  name: string;
  status: string;
  lastUpdateAt: string;
  message: string;
  url: string | null;
  translatedName?: string;
  translatedMessage?: string;
}

export interface CurrentStatusResult {
  ok: true;
  checkedAt: string;
  component: MonitorStateV1["component"];
  incidents: CurrentIncident[];
  incidentFeedDegraded: boolean;
}

export interface MonitorStateV1 {
  schemaVersion: 1;
  initializedAt: string;
  lastNotificationId?: string;
  component: {
    id: string;
    name: string;
    status: string;
    updatedAt: string | null;
  };
  activeIncidents: Record<string, string>;
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
  trigger: "cron";
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
  DISPLAY_TIME_ZONE?: string;
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
