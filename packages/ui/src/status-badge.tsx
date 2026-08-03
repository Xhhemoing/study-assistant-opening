import { AlertTriangle, CheckCircle2, CircleDot, HelpCircle } from "lucide-react";
import type { StatusWord } from "@aistudy/contracts";

const STATUS_CONFIG: Record<StatusWord, { label: string; icon: typeof CheckCircle2; tone: string }> = {
  stable: { label: "稳固", icon: CheckCircle2, tone: "bg-success/10 text-success" },
  usable: { label: "可用", icon: CircleDot, tone: "bg-primary/10 text-primary" },
  weak: { label: "薄弱", icon: AlertTriangle, tone: "bg-warning/10 text-warning" },
  untested: { label: "未测", icon: HelpCircle, tone: "bg-text-dim/10 text-text-dim" },
};

export function StatusBadge({ status }: { status: StatusWord }) {
  const config = STATUS_CONFIG[status];
  const Icon = config.icon;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-xs font-semibold ${config.tone}`} aria-label={`状态：${config.label}`}>
      <Icon aria-hidden="true" size={14} strokeWidth={2} />
      <span>{config.label}</span>
    </span>
  );
}
