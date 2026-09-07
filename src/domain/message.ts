import type { MonitorEvent, CurrentStatusResult } from "../types";
import { toIncidentEvent } from "./incidents";
import { statusLabel } from "./component";
import { formatDateTime } from "../utils/time";

const MAX_BYTES = 3500;

export function buildNotificationParts(
  events: MonitorEvent[],
  currentStatus: string,
  observedAt: string,
  timeZone: string,
): string[] {
  const recovering = events.some(
    (event) =>
      event.type === "component-status-changed" &&
      event.previousStatus !== null &&
      event.currentStatus === "operational",
  );
  const header = [
    currentStatus === "operational"
      ? recovering
        ? "Codex API 已恢复"
        : "Codex API 当前状态"
      : "Codex API 状态异常",
    `当前状态：${statusLabel(currentStatus)}`,
    `检测时间：${formatDateTime(observedAt, timeZone)} ${timeZone}`,
  ].join("\n");
  const blocks = events
    .filter(
      (event) =>
        currentStatus !== "operational" ||
        event.type === "component-status-changed",
    )
    .map((event) => formatEvent(event, timeZone));
  return chunkBlocks(header, blocks, MAX_BYTES);
}

export function buildCurrentStatusReply(
  result: CurrentStatusResult,
  timeZone: string,
): string {
  const header = [
    `${result.component.name} 当前状态：${statusLabel(result.component.status)}`,
    `检测时间：${formatDateTime(result.checkedAt, timeZone)} ${timeZone}`,
  ].join("\n");
  if (result.component.status === "operational") return header;
  if (result.incidentFeedDegraded) return `${header}\n当前事件详情暂不可用`;
  const parts = chunkBlocks(
    header,
    result.incidents.map((incident) =>
      formatEvent(toIncidentEvent(incident), timeZone),
    ),
    MAX_BYTES,
  );
  return (
    (parts[0] ?? `${header}\n暂无关联事件详情`) +
    (parts.length > 1 ? "\n其余事件：https://status.openai.com/" : "")
  );
}

export function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function formatEvent(event: MonitorEvent, timeZone: string): string {
  if (event.type === "component-status-changed") {
    return [
      "组件状态变化",
      `${event.previousStatus ? statusLabel(event.previousStatus) : "首次观察"} → ${statusLabel(event.currentStatus)}`,
    ].join("\n");
  }
  return [
    event.revised ? "关联事件更新（官方修订）" : "关联事件更新",
    event.translatedIncidentName ?? event.incidentName,
    ...(event.translatedIncidentName
      ? [`官方标题：${event.incidentName}`]
      : []),
    `阶段：${statusLabel(event.updateStatus)}`,
    `官方时间：${formatDateTime(event.eventAt, timeZone)} ${timeZone}`,
    event.translatedBody
      ? `中文翻译：\n${truncateToBytes(event.translatedBody, 1400)}\n\n官方原文：\n${truncateToBytes(event.body, 1200)}`
      : `官方原文：\n${truncateToBytes(event.body, 2200)}`,
    event.shortlink ?? "https://status.openai.com/",
  ].join("\n");
}

function chunkBlocks(
  header: string,
  blocks: string[],
  maxBytes: number,
): string[] {
  if (blocks.length === 0) return [];
  const parts: string[] = [];
  let current = header;
  for (const block of blocks) {
    const candidate = `${current}\n\n${block}`;
    if (utf8Length(candidate) <= maxBytes) {
      current = candidate;
      continue;
    }
    if (current !== header) parts.push(current);
    current = `${header}\n\n${truncateToBytes(block, maxBytes - utf8Length(header) - 4)}`;
  }
  parts.push(current);
  if (parts.length === 1) return parts;
  return parts.map(
    (part, index) => `${part}\n\n第 ${index + 1}/${parts.length} 条`,
  );
}

function truncateToBytes(value: string, maxBytes: number): string {
  if (utf8Length(value) <= maxBytes) return value;
  const suffix = "\n[正文过长，已省略]";
  const target = maxBytes - utf8Length(suffix);
  let output = "";
  for (const character of value) {
    if (utf8Length(output + character) > target) break;
    output += character;
  }
  return output + suffix;
}
