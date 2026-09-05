import type { LucideIcon } from "lucide-react";

export type NotebookMode = "edit" | "learn";
export type OverlayName = "ai" | "page-info" | "share" | null;

export type BlockOption = {
  actionName: string;
  description: string;
  group: "基础内容" | "媒体与数据" | "学习闭环";
  icon: LucideIcon;
  label: string;
};

export const pageTitle = "概率推理：从贝叶斯公式到决策";

export const pageInfo = [
  { label: "状态", value: "进行中" },
  { label: "标签", value: "概率论 · 决策" },
  { label: "来源", value: "来源锚点 · 教材第 42 页" },
  { label: "版本", value: "当前版本 · v12" },
];

export const blockGroups: BlockOption["group"][] = ["基础内容", "媒体与数据", "学习闭环"];

export function documentClass(mode: NotebookMode) {
  return mode === "learn" ? "学习版" : "编辑版";
}
