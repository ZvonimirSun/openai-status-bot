import type {
  IncidentMatchMode,
  IncidentUpdateEvent,
  StatusIncident,
} from "../types";

const NON_API_SURFACES = [
  "codex cloud",
  "codex web",
  "codex in chatgpt desktop",
  "codex desktop",
  "codex cli",
  "vs code extension",
];

export function isRelevantIncident(
  incident: StatusIncident,
  mode: IncidentMatchMode,
): boolean {
  const text = normalizeText(
    [
      incident.name,
      ...incident.incident_updates.map((update) => update.body),
    ].join("\n"),
  );
  if (text.includes("codex api")) return true;
  if (mode === "strict") return false;
  if (!containsWord(text, "codex")) return false;
  if (mode === "broad") return true;
  const stripped = NON_API_SURFACES.reduce(
    (current, phrase) => current.replaceAll(phrase, ""),
    text,
  );
  return containsWord(stripped, "codex");
}

export function collectIncidentChanges(
  incidents: StatusIncident[],
  mode: IncidentMatchMode,
  previous: Record<string, string>,
  recovering = false,
): {
  events: IncidentUpdateEvent[];
  activeIncidents: Record<string, string>;
  candidateCount: number;
} {
  const activeIncidents: Record<string, string> = {};
  const events: IncidentUpdateEvent[] = [];
  let candidateCount = 0;
  for (const incident of [...incidents].sort((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    if (!isRelevantIncident(incident, mode)) continue;
    const closed = ["resolved", "postmortem"].includes(incident.status);
    const existing = previous[incident.id];
    // Closed history is only relevant to an incident already being tracked.
    if ((closed || recovering) && !existing) continue;
    const update = [...incident.incident_updates].sort(
      (a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at),
    )[0];
    if (!update) continue;
    candidateCount += 1;
    const updatedAt = incident.updated_at ?? update.updated_at;
    if (!closed && !recovering) activeIncidents[incident.id] = updatedAt;
    if (existing !== updatedAt) {
      events.push({
        type: "incident-update",
        incidentId: incident.id,
        incidentName: incident.name,
        incidentStatus: incident.status,
        updateId: update.id,
        updateStatus: update.status,
        body: update.body,
        eventAt: update.updated_at,
        shortlink: incident.shortlink,
        revised: false,
      });
    }
  }
  return {
    events: events.sort(
      (left, right) => Date.parse(left.eventAt) - Date.parse(right.eventAt),
    ),
    activeIncidents,
    candidateCount,
  };
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

function containsWord(value: string, word: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${word}([^a-z0-9]|$)`, "i").test(value);
}
