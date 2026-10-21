import type { LearningObservation } from "@aistudy/contracts";
import { learnerEvidenceLabels, learnerEvidenceState } from "./learner-evidence-state";

export function LearnerStatePanel({ observation, refreshing = false }: { observation: LearningObservation; refreshing?: boolean }) {
  const state = refreshing ? "insufficient" : learnerEvidenceState(observation);
  return <div className="space-y-1 text-sm leading-6 text-text-2" data-learner-evidence-state={state}>
    <p>本次学习状态：<strong className="font-medium text-text">{learnerEvidenceLabels[state]}</strong></p>
    <p className="text-xs leading-5">{refreshing ? "作答条件已改变，正在核对最新证据。" : state === "independent" ? "本次作答通过独立核验；长期保持仍需后续复测。" : state === "hinted" ? "这次答对时使用了提示，下一步可用新题独立检查。" : state === "retest" ? "先核对解题过程，再用新题复测；尚未自动安排时间。" : "当前记录尚不能确认独立完成，原答案与帮助记录仍保留。"}</p>
  </div>;
}
