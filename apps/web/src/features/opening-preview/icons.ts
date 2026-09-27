import { BookOpen, MessageCircle, Sun, type LucideIcon } from "lucide-react";
import type { PreviewView } from "./model";

export const NAV: { view: PreviewView; label: string; icon: LucideIcon }[] = [
  { view: "today", label: "今日", icon: Sun },
  { view: "assistant", label: "助理", icon: MessageCircle },
  { view: "courses", label: "课程", icon: BookOpen },
];

export const STATUS_LABEL = { ready: "可阅读", processing: "处理中", failed: "未能提取" } as const;

export function statusClass(status: keyof typeof STATUS_LABEL): string {
  if (status === "ready") return "bg-emerald-50 text-emerald-800 ring-emerald-200";
  if (status === "processing") return "bg-amber-50 text-amber-800 ring-amber-200";
  return "bg-rose-50 text-rose-800 ring-rose-200";
}
