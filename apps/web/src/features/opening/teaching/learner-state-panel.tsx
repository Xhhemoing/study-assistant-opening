import type { LearningObservation } from "@aistudy/contracts";
import { learnerEvidenceLabels, learnerEvidenceState } from "./learner-evidence-state";

export function LearnerStatePanel({ observation, refreshing = false }: { observation: LearningObservation; refreshing?: boolean }) {
  const state = refreshing ? "insufficient" : learnerEvidenceState(observation);
  return <div className="space-y-1 text-sm leading-6 text-text-2" data-learner-evidence-state={state}>
    <p>本次学习状态：<strong className="font-medium text-text">{learnerEvidenceLabels[state]}</strong></p>
    <p className="text-xs leading-5">{refreshing ? "正在更新这次作答结果。" : state === "independent" ? "这次你独立答对了。之后再练一道，看看能否继续独立完成。" : state === "hinted" ? "这次答对时使用了提示，下一步试着独立完成一道新题。" : state === "retest" ? "先看看解题过程哪里需要调整，再试一道新题。" : "还需要更多练习来了解你能独立完成哪些内容。"}</p>
  </div>;
}
