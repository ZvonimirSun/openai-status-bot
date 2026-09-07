import type { CurrentIncident, IncidentUpdateEvent } from "../types";

export function toIncidentEvent(
  incident: CurrentIncident,
): IncidentUpdateEvent {
  return {
    type: "incident-update",
    incidentId: incident.id,
    incidentName: incident.name,
    incidentStatus: incident.status,
    updateId: `${incident.id}:${incident.lastUpdateAt}`,
    updateStatus: incident.status,
    body: incident.message,
    eventAt: incident.lastUpdateAt,
    shortlink: incident.url,
    revised: false,
    ...(incident.translatedName
      ? { translatedIncidentName: incident.translatedName }
      : {}),
    ...(incident.translatedMessage
      ? { translatedBody: incident.translatedMessage }
      : {}),
  };
}

export function collectIncidentChanges(
  incidents: CurrentIncident[],
  previous: Record<string, string>,
) {
  const activeIncidents = Object.fromEntries(
    [...incidents]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((incident) => [incident.id, incident.lastUpdateAt]),
  );
  const events = incidents
    .filter((incident) => previous[incident.id] !== incident.lastUpdateAt)
    .map(toIncidentEvent)
    .sort((a, b) => Date.parse(a.eventAt) - Date.parse(b.eventAt));
  return { events, activeIncidents, candidateCount: incidents.length };
}
