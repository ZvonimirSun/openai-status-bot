import type { ComponentStatus, StatusComponent } from "../types";

const KNOWN_STATUSES = new Set<ComponentStatus>([
  "operational",
  "degraded_performance",
  "partial_outage",
  "major_outage",
  "under_maintenance",
]);

export function selectTargetComponent(
  components: StatusComponent[],
  targetName: string,
): StatusComponent {
  const component = components.find((item) => item.name === targetName);
  if (!component) throw new Error(`Component not found: ${targetName}`);
  if (!KNOWN_STATUSES.has(component.status as ComponentStatus)) {
    console.error(
      JSON.stringify({
        errorCategory: "unknown-component-status",
        status: component.status,
      }),
    );
    throw new Error(`Unknown component status: ${component.status}`);
  }
  return component;
}

export function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    operational: "正常",
    degraded_performance: "性能下降",
    partial_outage: "部分中断",
    major_outage: "严重中断",
    under_maintenance: "维护中",
    investigating: "调查中",
    identified: "原因已确认",
    monitoring: "监控恢复中",
    resolved: "已恢复",
    postmortem: "事故复盘",
  };
  return labels[status] ?? `未知状态 (${status})`;
}
