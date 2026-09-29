import type { LearningEvidenceEligibility } from "@aistudy/contracts";
import { ELIGIBILITY_VALUE_LABEL, eligibilityReasonLabels } from "./eligibility-presentation";

export function LearningEvidenceEligibilityDetails({ eligibility, versionApplicability }: { eligibility: LearningEvidenceEligibility; versionApplicability?: string }) {
  return (
    <details className="w-full text-xs text-zinc-500">
      <summary className="cursor-pointer py-1">查看资格与原因</summary>
      <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1">
        <dt>本次独立作答</dt><dd>{ELIGIBILITY_VALUE_LABEL[eligibility.independentAttempt]}</dd>
        <dt>有依据的参考核验</dt><dd>{ELIGIBILITY_VALUE_LABEL[eligibility.verifiedCorrect]}</dd>
        <dt>适用于当前版本</dt><dd>{ELIGIBILITY_VALUE_LABEL[eligibility.usableForCurrentVersion]}</dd>
        <dt>用于延迟检验</dt><dd>{ELIGIBILITY_VALUE_LABEL[eligibility.usableForDelayedCheck]}</dd>
      </dl>
      {versionApplicability === "unavailable" ? <p className="mt-2">来源或历史版本不可用；保留原始观察，但不据此生成补测引用。</p> : null}
      <ul className="mt-2 list-inside list-disc space-y-1">{eligibilityReasonLabels(eligibility).map((reason) => <li key={reason}>{reason}</li>)}</ul>
      <p className="mt-2">资格说明不改变原始自报结果，也不代表系统客观判分或已经掌握。</p>
    </details>
  );
}
