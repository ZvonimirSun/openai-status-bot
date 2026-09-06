import type {
  IncidentMatchMode,
  IncidentRevisionRecord,
  IncidentUpdateEvent,
  StatusIncident,
} from "../types";
import { sha256 } from "../utils/hash";
import { isWithinLookback } from "../utils/time";

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

export async function fingerprintUpdate(
  incident: StatusIncident,
  update: StatusIncident["incident_updates"][number],
): Promise<string> {
  return sha256(
    [
      incident.id,
      normalizeText(incident.name),
      update.id,
      update.status,
      update.updated_at,
      normalizeText(update.body),
    ].join("\n"),
  );
}

export async function collectIncidentChanges(
  incidents: StatusIncident[],
  mode: IncidentMatchMode,
  previous: Record<string, IncidentRevisionRecord>,
  now: Date,
  lookbackDays: number,
  latestOnly = false,
): Promise<{
  events: IncidentUpdateEvent[];
  revisions: Record<string, IncidentRevisionRecord>;
  candidateCount: number;
}> {
  const revisions = { ...previous };
  const events: IncidentUpdateEvent[] = [];
  let candidateCount = 0;
  for (const incident of incidents.filter((item) =>
    isRelevantIncident(item, mode),
  )) {
    const updates = latestOnly
      ? [...incident.incident_updates]
          .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
          .slice(0, 1)
      : incident.incident_updates;
    for (const update of updates) {
      if (!isWithinLookback(update.updated_at, now, lookbackDays)) continue;
      candidateCount += 1;
      const fingerprint = await fingerprintUpdate(incident, update);
      const existing = previous[update.id];
      revisions[update.id] = { fingerprint, eventAt: update.updated_at };
      if (!existing || existing.fingerprint !== fingerprint) {
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
          revised: Boolean(existing),
        });
      }
    }
  }
  return {
    events: events.sort(
      (left, right) => Date.parse(left.eventAt) - Date.parse(right.eventAt),
    ),
    revisions: pruneRevisions(revisions, now, lookbackDays),
    candidateCount,
  };
}

export function pruneRevisions(
  revisions: Record<string, IncidentRevisionRecord>,
  now: Date,
  lookbackDays: number,
  limit = 500,
): Record<string, IncidentRevisionRecord> {
  return Object.fromEntries(
    Object.entries(revisions)
      .filter(([, record]) =>
        isWithinLookback(record.eventAt, now, lookbackDays),
      )
      .sort(
        ([, left], [, right]) =>
          Date.parse(right.eventAt) - Date.parse(left.eventAt),
      )
      .slice(0, limit),
  );
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

function containsWord(value: string, word: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${word}([^a-z0-9]|$)`, "i").test(value);
}
