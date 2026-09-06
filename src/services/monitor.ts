import type { AppConfig } from "../config";
import type { OpenAIStatusClient } from "../clients/openai-status";
import type { Notifier } from "../clients/notifiers";
import type { TranslationClient } from "../clients/translation-client";
import type {
  ComponentStatusChangedEvent,
  MonitorEvent,
  MonitorRunResult,
  MonitorStateV1,
  RunTrigger,
} from "../types";
import { selectTargetComponent } from "../domain/component";
import { collectIncidentChanges } from "../domain/incidents";
import { buildNotificationParts } from "../domain/message";
import type {
  MonitorStateRepository,
  PendingNotification,
} from "../repositories/monitor-state";

export class MonitorService {
  constructor(
    private readonly config: AppConfig,
    private readonly client: OpenAIStatusClient,
    private readonly repository: MonitorStateRepository,
    private readonly notifier: Notifier,
    private readonly translator: TranslationClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async run(trigger: RunTrigger): Promise<MonitorRunResult> {
    const isCron = trigger === "cron";
    const channels = (await this.notifier.channelIds?.()) ?? ["default"];
    const startedAt = Date.now();
    const observed = this.now();
    const observedAt = observed.toISOString();
    try {
      if (isCron && (await this.resumeDelivery())) {
        const state = await this.repository.load();
        return {
          ok: true,
          trigger,
          bootstrap: false,
          changed: true,
          notified: channels.length > 0,
          committed: true,
          componentStatus: state?.component.status ?? null,
          previousComponentStatus: null,
          events: [],
          incidentFeedDegraded: false,
          messageParts: 0,
          reason: "delivery-resumed",
        };
      }
      const loaded = await this.repository.load();
      const previousStatus = loaded?.component.status ?? null;
      const snapshot = await this.client.fetchSnapshot((components) => {
        const current = selectTargetComponent(
          components,
          this.config.targetComponentName,
        );
        return (
          current.status !== "operational" ||
          (isCron &&
            previousStatus !== null &&
            previousStatus !== "operational")
        );
      });
      const component = selectTargetComponent(
        snapshot.components,
        this.config.targetComponentName,
      );
      const bootstrap = loaded === null;
      const previousIncidents = loaded?.activeIncidents ?? {};
      const recovering = component.status === "operational";
      let activeIncidents = recovering ? {} : previousIncidents;
      let incidentEvents: MonitorEvent[] = [];
      let candidateCount = 0;
      if (snapshot.incidents) {
        const changes = collectIncidentChanges(
          snapshot.incidents,
          this.config.incidentMatchMode,
          isCron ? previousIncidents : {},
          recovering,
        );
        activeIncidents = changes.activeIncidents;
        candidateCount = changes.candidateCount;
        incidentEvents = changes.events;
      }

      const componentChanged =
        previousStatus !== null && previousStatus !== component.status;
      const componentEvent: ComponentStatusChangedEvent | null =
        componentChanged
          ? {
              type: "component-status-changed",
              previousStatus,
              currentStatus: component.status,
              componentId: component.id,
              componentName: component.name,
              componentUpdatedAt: component.updated_at,
              observedAt,
            }
          : null;
      let events = componentEvent
        ? [componentEvent, ...incidentEvents]
        : incidentEvents;
      if (bootstrap && isCron) {
        events = componentEvent ? [componentEvent] : [];
      }
      if (bootstrap && this.config.notifyOnBootstrap && isCron) {
        events = [
          {
            type: "component-status-changed",
            previousStatus: null,
            currentStatus: component.status,
            componentId: component.id,
            componentName: component.name,
            componentUpdatedAt: component.updated_at,
            observedAt,
          },
          ...incidentEvents,
        ];
      }

      const nextState: MonitorStateV1 = {
        schemaVersion: 1,
        initializedAt: loaded?.initializedAt ?? observedAt,
        ...(loaded?.lastNotificationId
          ? { lastNotificationId: loaded.lastNotificationId }
          : {}),
        component: {
          id: component.id,
          name: component.name,
          status: component.status,
          updatedAt: component.updated_at,
        },
        activeIncidents,
      };
      const changed = events.length > 0;
      const translatedEvents =
        isCron && channels.length === 0
          ? events
          : await this.translator.translate(events);
      const parts = buildNotificationParts(
        translatedEvents,
        component.status,
        observedAt,
        this.config.displayTimeZone,
      );
      let notified = false;
      let committed = false;
      if (isCron) {
        if (parts.length > 0 && channels.length > 0) {
          const pending: PendingNotification = {
            id: crypto.randomUUID(),
            nextState,
            parts,
            channels,
            delivered: [],
          };
          await this.repository.savePending(pending);
          await this.resumeDelivery(pending);
          notified = true;
          committed = true;
        }
        if (
          !committed &&
          (changed ||
            bootstrap ||
            JSON.stringify(activeIncidents) !==
              JSON.stringify(loaded?.activeIncidents))
        ) {
          await this.repository.save(nextState);
          committed = true;
        }
      }
      const result: MonitorRunResult = {
        ok: true,
        trigger,
        bootstrap,
        changed,
        notified,
        committed,
        componentStatus: component.status,
        previousComponentStatus: previousStatus,
        events: translatedEvents,
        incidentFeedDegraded: snapshot.incidentFeedDegraded,
        messageParts: parts.length,
        reason: bootstrap ? "baseline" : changed ? "changed" : "unchanged",
      };
      logSummary(result, candidateCount, Date.now() - startedAt);
      return result;
    } catch (error) {
      console.error(
        JSON.stringify({
          trigger,
          result: "failed",
          durationMs: Date.now() - startedAt,
          errorCategory: classifyError(error),
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      throw error;
    }
  }
  private async resumeDelivery(
    created?: PendingNotification,
  ): Promise<boolean> {
    const pending = created ?? (await this.repository.pending());
    if (!pending) return false;
    if (!created) {
      const state = await this.repository.load();
      if (state?.lastNotificationId === pending.id) {
        // Keep the completed marker until the next batch replaces it. This
        // avoids same-key delete/put bursts and writes during quiet periods.
        return false;
      }
      await this.repository.loadReceipts(pending);
    }
    await this.notifier.send(pending.parts, {
      channels: pending.channels,
      delivered: pending.delivered,
      checkpoint: () =>
        this.repository.recordReceipt(
          pending,
          pending.delivered[pending.delivered.length - 1]!,
        ),
    });
    await this.repository.save({
      ...pending.nextState,
      lastNotificationId: pending.id,
    });
    return true;
  }
}

function logSummary(
  result: MonitorRunResult,
  candidateIncidentUpdates: number,
  durationMs: number,
): void {
  console.log(
    JSON.stringify({
      runId: crypto.randomUUID(),
      trigger: result.trigger,
      bootstrap: result.bootstrap,
      componentStatus: result.componentStatus,
      previousComponentStatus: result.previousComponentStatus,
      statusChanged: result.events.some(
        (event) => event.type === "component-status-changed",
      ),
      candidateIncidentUpdates,
      newIncidentUpdates: result.events.filter(
        (event) => event.type === "incident-update",
      ).length,
      messageParts: result.messageParts,
      notified: result.notified,
      durationMs,
      result: result.incidentFeedDegraded ? "degraded" : "success",
    }),
  );
}

function classifyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Telegram")) return "telegram";
  if (message.includes("WeCom")) return "wecom";
  if (message.includes("KV") || message.includes("binding")) return "kv";
  if (message.includes("component") || message.includes("OpenAI"))
    return "openai-status";
  return "unknown";
}
