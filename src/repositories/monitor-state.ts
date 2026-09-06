import type { MonitorStateV1 } from "../types";

export const STATE_KEY = "monitor:v1:openai:codex-api";
const PENDING_KEY = "pending-notification";

export interface PendingNotification {
  id: string;
  nextState: MonitorStateV1;
  parts: string[];
  channels: string[];
  delivered: string[];
}

export class MonitorStateRepository {
  constructor(private readonly kv: KVNamespace) {}

  async load(): Promise<MonitorStateV1 | null> {
    return this.kv.get<MonitorStateV1>(STATE_KEY, "json");
  }

  async save(state: MonitorStateV1): Promise<void> {
    await this.kv.put(STATE_KEY, JSON.stringify(state));
  }

  async pending(): Promise<PendingNotification | undefined> {
    return (
      (await this.kv.get<PendingNotification>(PENDING_KEY, "json")) ?? undefined
    );
  }

  async savePending(pending: PendingNotification): Promise<void> {
    const previous = await this.pending();
    if (previous) await this.clearReceipts(previous);
    await this.kv.put(PENDING_KEY, JSON.stringify(pending));
  }

  async loadReceipts(pending: PendingNotification): Promise<void> {
    for (const channel of pending.channels) {
      for (let index = 0; index < pending.parts.length; index += 1) {
        const receipt = `${channel}:${index}`;
        if ((await this.kv.get(this.receiptKey(pending, receipt))) !== null)
          pending.delivered.push(receipt);
      }
    }
  }

  async recordReceipt(
    pending: PendingNotification,
    receipt: string,
  ): Promise<void> {
    await this.kv.put(this.receiptKey(pending, receipt), "1");
  }

  async clearReceipts(pending: PendingNotification): Promise<void> {
    for (const channel of pending.channels) {
      for (let index = 0; index < pending.parts.length; index += 1)
        await this.kv.delete(this.receiptKey(pending, `${channel}:${index}`));
    }
  }

  private receiptKey(pending: PendingNotification, receipt: string): string {
    return `delivery:${pending.id}:${receipt}`;
  }

  async sanitizedState(): Promise<MonitorStateV1 | null> {
    const loaded = await this.load();
    return loaded;
  }
}
