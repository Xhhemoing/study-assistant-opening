import type { LearningEvidenceEligibility } from "@aistudy/contracts";

const REASON_LABELS: Record<string, string> = {
  observation_identity_incomplete: "缺少尝试、题目或当时版本，待核验",
  attempt_timing_unknown: "尝试的开始或提交时序不明",
  help_history_incomplete: "帮助历史不完整",
  help_delivery_unknown: "帮助是否可取回不明",
  help_association_unknown: "帮助与本题的关联不明",
  help_order_unknown: "帮助与提交的先后不明",
  help_before_submission: "提交前已有可取回的帮助",
  declared_help: "本次记录包含提示或答案帮助",
  assistance_unknown: "本次帮助情况未确认",
  prior_answer_exposure: "历史上已有同题答案曝光记录",
  verification_source_untrusted: "自报或模型建议尚未构成参考核验",
  reference_check_incomplete: "缺少参考依据、核对方法或检查者",
  reference_check_scope_incomplete: "参考核对未覆盖完整答案",
  reference_check_identity_mismatch: "参考核对与本次题目或版本不一致",
  reference_check_outcome_conflict: "参考核对与记录结果不一致",
  reference_checked_correct: "有记录的参考核对结果为正确",
  reference_checked_incorrect: "有记录的参考核对结果为错误",
  outcome_unverified: "结果尚未核验",
  version_unknown: "当时内容版本不明",
  version_exact: "对应当前内容版本",
  version_exact_mismatch: "记录与当前内容版本不一致",
  version_equivalent_confirmed: "版本等价性已在限定范围内确认",
  version_equivalence_unconfirmed: "版本等价性尚未确认",
  version_changed_needs_check: "材料或题目已变化，旧记录需复核",
  version_unavailable: "引用来源或历史版本不可用",
  version_privacy_excluded: "引用来源已被隐私排除",
  delayed_protocol_incomplete: "没有完整延迟检验协议",
  delayed_protocol_mismatch: "延迟检验协议与本次尝试不一致",
  delayed_check_too_early: "本次开始时间早于延迟检验要求",
  delayed_prior_answer_policy_unknown: "延迟检验对既往答案曝光的要求不明",
  delayed_requires_unseen_problem: "延迟检验要求未见答案的新题",
  delayed_prerequisite_not_met: "尚未满足延迟检验的前置资格",
  delayed_prerequisite_unknown: "延迟检验的前置资格仍待核验",
};

export function eligibilityReasonLabels(eligibility: LearningEvidenceEligibility): string[] {
  return [...new Set(eligibility.reasonCodes.map((code) => REASON_LABELS[code] ?? "资格原因尚无法解释，请保留待核验状态"))];
}

export const ELIGIBILITY_VALUE_LABEL = { yes: "符合", no: "不符合", unknown: "待核验" } as const;
