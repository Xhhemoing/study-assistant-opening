import { TransitionLink as Link } from "../v3/motion/view-transition";
import type { ReactNode } from "react";
import type { LearningObservation } from "@aistudy/contracts";
import { ui } from "../design/ui";

export type AttemptStage = "draft" | "processing" | "recognition-pending" | "evaluation-pending" | "failed" | "reliable" | "corrected";

/** Only effective service verdicts qualify; hints and model confidence do not. */
export function observationStage(record: LearningObservation): AttemptStage {
  if (record.revisionKind === "replace" && record.verdictSource === "self_report") return "corrected";
  if (record.outcome === "unverified" || record.aiEvaluation?.questionMatch === false) return "evaluation-pending";
  if (record.verdictSource === "ai_graded" && record.aiEvaluation
    || record.verdictSource === "deterministic" && record.serverEvaluation && record.serverEvaluation.decision !== "abstain") return "reliable";
  return "evaluation-pending";
}

/** An explicit learner correction can finish a practice without claiming a verified grade. */
export function canCompleteObservation(record: LearningObservation): boolean {
  if (record.revisionKind === "retract" || record.effectiveHeadId && record.effectiveHeadId !== record.id) return false;
  const stage = observationStage(record);
  return stage === "reliable" || stage === "corrected" && record.outcome !== "unverified";
}

export type AttemptPrimaryAction = { label: string; onClick?: () => void; type?: "button" | "submit"; disabled?: boolean; href?: string };

/** The caller owns the action and its real service operation. Never invent a next step. */
export function StageActionBar({ stage, message, primary, children }: {
  stage: AttemptStage; message?: string;
  primary?: AttemptPrimaryAction;
  children?: ReactNode;
}) {
  const warning = stage === "recognition-pending" || stage === "evaluation-pending" || stage === "failed";
  return <div data-attempt-stage={stage} className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
    <div className="min-w-0 flex-1 space-y-2">
      {message ? <p role={stage === "failed" ? "alert" : "status"} className={`text-sm leading-6 ${warning ? "text-warn" : "text-text-2"}`}>{message}</p> : null}
      {children ? <div className="flex flex-wrap items-center gap-3">{children}</div> : null}
    </div>
    {primary && stage !== "processing" ? primary.href && !primary.disabled
      ? <Link className={ui.primary} href={primary.href}>{primary.label}</Link>
      : <button className={ui.primary} type={primary.type ?? "button"} disabled={primary.disabled} onClick={primary.onClick}>{primary.label}</button> : null}
  </div>;
}
