import type { Exploration } from "@aistudy/contracts";

export const EXPLORATION_STARTERS = [
  { id: "concept", label: "帮我理解一个概念", prompt: "帮我理解一个概念：" },
  { id: "material", label: "整理一段资料", prompt: "整理一段资料：" },
  { id: "web", label: "分析网页内容", prompt: "分析网页内容：" },
] as const;

const STATUS_LABELS: Record<Exploration["status"], string> = {
  open: "进行中",
  closed: "已结束",
};

export function explorationStatusLabel(status: Exploration["status"]): string {
  return STATUS_LABELS[status];
}

export function explorationPath(id: string): string {
  return `/explore/${encodeURIComponent(id)}`;
}
