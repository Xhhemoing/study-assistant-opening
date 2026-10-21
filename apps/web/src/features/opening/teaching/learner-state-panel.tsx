"use client";
import type { LearningObservation } from "@aistudy/contracts";
import { learnerEvidenceLabels, learnerEvidenceState } from "./learner-evidence-state";
import { useDiagnosticsEnabled } from "../settings/appearance-preferences";
import { studentCopy } from "./student-copy";

export function LearnerStatePanel({ observation, refreshing = false }: { observation: LearningObservation; refreshing?: boolean }) {
  const state = refreshing ? "insufficient" : learnerEvidenceState(observation);
  const diagnostics = useDiagnosticsEnabled();
  const current = observation.revisionKind !== "retract" && (!observation.effectiveHeadId || observation.effectiveHeadId === observation.id);
  return <div className="space-y-1 text-sm leading-6 text-text-2" data-learner-evidence-state={state}>
    {diagnostics ? <p>本次学习状态：<strong className="font-medium text-text">{learnerEvidenceLabels[state]}</strong></p> : null}
    <p className="text-xs leading-5">{refreshing ? "正在更新这次作答结果。" : current && observation.eligibility?.verifiedCorrect === "yes" ? studentCopy.nextCorrect : current && observation.eligibility?.verifiedCorrect === "no" ? studentCopy.nextIncorrect : "可以对照解法，检查自己的思路。"}</p>
  </div>;
}
