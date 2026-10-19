import type { TransactionSql } from "postgres";
import type { Scope, SystemQueryRequest } from "@aistudy/contracts";
import { nextLearningStep, summarizeObservations, resolveEvidenceAssistance } from "@aistudy/domain";
import { openingEligibilityStateQuery, openingEligibilityPolicyVersion } from "./opening-learning-eligibility";
import { readOpeningLearningEvidenceContexts } from "./opening-learning-evidence-context";
import { mapLearningObservation } from "./opening-learning-facts";
import type { OpeningSystemQueryDraft } from "./opening-system-query";
import { readSystemQueryAncestry } from "./opening-system-query-admission";
const qualification = (value: unknown) => ({ yes: "是", no: "否", unknown: "未知" })[String(value)] ?? "未知";
const helpLabel = (value: unknown) => ({ independent: "独立完成", hinted: "获得提示", revealed: "已展示解法", unknown: "未知" })[String(value)] ?? "未知";
const outcomeLabel = (value: unknown) => ({ correct: "正确", incorrect: "错误", partial: "部分正确", unverified: "未核验" })[String(value)] ?? "未核验";

/** Uses the existing projection's live dependency checks, without ensure/repair or authority upgrades. */
export async function readSystemLearningQuery(tx: TransactionSql, scope: Scope,
  request: Extract<SystemQueryRequest, { name: "learning" | "recommendation" }>, out: OpeningSystemQueryDraft, limit: number, offset: number) {
  const courseId = request.arguments.courseId;
  const [course] = await tx`SELECT id FROM courses WHERE workspace_id=${scope.workspaceId} AND id=${courseId} AND archived_at IS NULL`;
  if (!course) { out.status = "unknown"; out.reason = "not_available"; return; }
  const state = openingEligibilityStateQuery(tx, scope, { courseId });
  const rows = await tx`SELECT * FROM (${state}) q WHERE NOT privacy_excluded
    ORDER BY COALESCE(submitted_at,occurred_at) DESC,id LIMIT ${limit + 1} OFFSET ${offset}`;
  out.version += `:${openingEligibilityPolicyVersion()}`;
  if (rows.length > limit) { out.status = "partial"; out.reason = "truncated"; out.nextOffset = offset + limit; }
  const selected = rows.slice(0, limit);
  const ancestry = await readSystemQueryAncestry(tx, scope, selected.map(row => String(row.current_root_id)));
  // Only fresh, currently applicable records with fully admitted ancestry reach the model.
  const safeRows = selected.filter(row => ancestry.admitted.has(String(row.current_root_id)) && row.fresh && ["exact", "equivalent_confirmed"].includes(String(row.version_applicability)));
  const mapped = safeRows.map(mapLearningObservation), contexts = await readOpeningLearningEvidenceContexts(tx, scope, mapped);
  const effectiveAssistance = new Map(mapped.map(row => [row.id, resolveEvidenceAssistance(contexts[row.id]!.observation, contexts[row.id]!.context)]));
  for (const row of safeRows) out.sourceRefs.push(...ancestry.admitted.get(String(row.current_root_id))!);
  if (safeRows.length !== selected.length) { out.status = "partial"; if (out.reason !== "truncated") out.reason = selected.some(row => !row.fresh || row.version_applicability === "changed_needs_check") ? "stale" : "not_available"; }
  if (!ancestry.complete) { out.status = "unknown"; out.reason = "truncated"; }
  if (safeRows.some(row => String(row.answer).length > 800)) { out.status = "partial"; out.reason = "truncated"; }
  out.data = safeRows.map(row => {
    out.evidence.push({ id: `observation:${row.id}`, kind: "observation", title: "实际作答记录", href: `/opening/courses/${courseId}?tab=records`,
      recordId: String(row.id), ...(row.attempt_id ? { attemptId: String(row.attempt_id) } : {}),
      ...(row.item_version_id ? { itemVersionId: String(row.item_version_id) } : {}), revision: String(row.workspace_history_revision) });
    return { id: row.id, rootId: row.current_root_id, attemptId: row.attempt_id, itemVersionId: row.item_version_id,
      skillLabel: row.skill_label, requirementKey: row.requirement_key,
        ...(out.authorization.purpose === "source_review" ? { answerExcerpt: String(row.answer).slice(0, 800), answerTruncated: String(row.answer).length > 800 } : { answerWithheld: true }),
        outcome: row.outcome, recordedAssistance: row.assistance, effectiveAssistance: effectiveAssistance.get(String(row.id)), eligibility: { independentAttempt: row.independent_attempt, verifiedCorrect: row.verified_correct,
          usableForCurrentVersion: row.usable_for_current_version, usableForDelayedCheck: row.usable_for_delayed_check, reasonCodes: row.reason_codes, policyVersion: row.projected_policy_version },
      projectionFresh: true, versionApplicability: row.version_applicability,
      liveHelpRevision: Number(row.live_help_revision), submittedAt: new Date((row.submitted_at ?? row.occurred_at) as Date).toISOString(),
      summary: `${row.skill_label}：记录结果为${outcomeLabel(row.outcome)}，实际帮助情况为${helpLabel(effectiveAssistance.get(String(row.id)))}；服务端资格：独立作答${qualification(row.independent_attempt)}，核验正确${qualification(row.verified_correct)}，适用当前版本${qualification(row.usable_for_current_version)}，可作延迟检查证据${qualification(row.usable_for_delayed_check)}。这些资格不等于已掌握` };
  });
  if (!safeRows.length && selected.length) out.status = "unknown";
  if (request.name !== "recommendation" || !selected.length) return;
  // A display limit must never turn into an apparently complete mastery/teaching decision.
  if (rows.length > limit || safeRows.length !== selected.length) {
    out.data = [{ summary: "当前证据不完整或资格待更新，无法可靠解释下一学习活动；请查看作答记录并缩小问题范围", recommendationStatus: "unknown" }];
    return;
  }
  const summaries = summarizeObservations(mapped, out.asOf, { evidenceContexts: contexts });
  out.data = summaries.map(summary => {
    const group = mapped.filter(row => row.skillLabel === summary.skillLabel && (contexts[row.id]?.observation.requirementKey ?? null) === summary.requirementKey);
    const step = nextLearningStep({ status: summary.status, wantsFullExplanation: false, observations: group.map(row => {
      const eligibility = summary.evidenceEligibility.find(e => e.observationId === row.id)!.eligibility;
      return { id: row.id, skillLabel: row.skillLabel, requirementKey: summary.requirementKey, attemptedAt: row.submittedAt ?? row.occurredAt,
        assistance: effectiveAssistance.get(row.id)!, problemId: row.problemId ?? null, independentAttempt: eligibility.independentAttempt,
        verifiedCorrect: eligibility.verifiedCorrect, usableForCurrentVersion: eligibility.usableForCurrentVersion };
    }) });
    const activity = ({ diagnose: "诊断", targeted_explain: "针对性讲解", full_explain: "完整讲解", reduced_help_practice: "减少帮助的练习", transfer_check: "迁移检查" })[step.activityKind];
    const reason = ({ no_evidence: "缺少可用证据", unverified_only: "现有结果尚未核验", verified_incorrect: "最近作答已核验为错误", assistance_dependent: "近期作答多次依赖帮助", independent: "当前记录支持独立完成，需要进一步检查迁移", needs_check: "仍需检查", requested_full: "学习者请求完整讲解" })[step.reasonCode];
    return { identity: { courseId, skillLabel: summary.skillLabel, requirementKey: summary.requirementKey }, step, evidenceIds: group.map(row => row.id),
      basis: "nextLearningStep/current-evidence", limitations: ["未读取复测到期状态或教学策略编译结果", "不是已保存或已接受的计划"],
      summary: `${summary.skillLabel}：现有活动规则建议${activity}，因为${reason}。依据 ${group.length} 条当前有效记录；未读取复测到期状态或教学策略编译结果，不代表已确认的计划或已掌握` };
  });
  out.status = "partial"; out.reason = "not_available";
}
