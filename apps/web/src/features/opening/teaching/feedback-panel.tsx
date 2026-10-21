import type { ReactNode } from "react";
import { CheckCircle2, CircleHelp, RotateCcw } from "lucide-react";

export function FeedbackPanel({ verdict, title, evidence, children }: { verdict: "correct" | "incorrect" | "unverified"; title: string; evidence: string; children?: ReactNode }) {
  const Icon = verdict === "correct" ? CheckCircle2 : verdict === "incorrect" ? RotateCcw : CircleHelp;
  return <section aria-label="本题反馈" data-feedback-verdict={verdict} className="space-y-3 rounded-card border border-line bg-surface-2 p-4">
    <div role="status" className="space-y-1">
      <h4 className="flex items-start gap-2 text-base font-semibold leading-7 text-text"><Icon className={verdict === "correct" ? "mt-1 shrink-0 text-accent" : "mt-1 shrink-0 text-text-2"} size={20} aria-hidden="true" />{title}</h4>
      <p className="text-sm leading-6 text-text-2">{evidence}</p>
    </div>
    {children}
  </section>;
}
