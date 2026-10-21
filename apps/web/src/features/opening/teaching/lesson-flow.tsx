import type { ReactNode } from "react";

export type LessonPhase = "attempt" | "hint" | "submit" | "feedback" | "next";
const phases: Array<[LessonPhase, string]> = [["attempt", "先尝试"], ["hint", "按需提示"], ["submit", "提交"], ["feedback", "核对反馈"], ["next", "下一步"]];

/** Shows the current interaction, never infers mastery from navigation. */
export function LessonFlow({ phase, children, hasHints = true }: { phase: LessonPhase; children: ReactNode; hasHints?: boolean }) {
  return <div className="space-y-4" data-lesson-phase={phase}>
    <ol aria-label="本题学习流程" className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-text-2">
      {phases.filter(([key]) => hasHints || key !== "hint").map(([key, label], index) => <li key={key} aria-current={key === phase ? "step" : undefined} className={key === phase ? "font-semibold text-text" : ""}>
        <span aria-hidden="true" className="mr-1 tabular-nums">{index + 1}.</span>{label}
      </li>)}
    </ol>
    {children}
  </div>;
}
