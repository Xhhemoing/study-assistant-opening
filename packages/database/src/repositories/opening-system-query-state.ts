import type { TransactionSql } from "postgres";
import type { Scope, SystemQueryRequest } from "@aistudy/contracts";
import type { OpeningSystemQueryDraft } from "./opening-system-query";
import { readOpeningLearnerState } from "./opening-learner-state-read";
import { explainOpeningLearningDecision } from "./opening-learning-decisions";
import { readSystemQueryAncestry } from "./opening-system-query-admission";
import { contextSourceRefsIncluded } from "./opening-context-provenance";

export async function readSystemStateQuery(tx: TransactionSql, scope: Scope,
  request: Extract<SystemQueryRequest, { name: "learner_state" | "explain_decision" }>, out: OpeningSystemQueryDraft) {
  if (request.name === "learner_state") {
    const state = await readOpeningLearnerState(tx, scope, request.arguments);
    const ids = state.features.map(feature => feature.observationId);
    const roots = ids.length ? await tx`SELECT COALESCE(root_observation_id,id) AS root FROM opening_learning_observations
      WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND id=ANY(${ids}::uuid[])` : [];
    const ancestry = await readSystemQueryAncestry(tx, scope, roots.map(row => String(row.root)));
    if (!ancestry.complete || roots.some(row => !ancestry.admitted.has(String(row.root)))) {
      out.status = "unknown"; out.reason = "not_available"; return;
    }
    out.sourceRefs.push(...[...ancestry.admitted.values()].flat());
    out.asOf = state.dataAsOf;
    out.version = `learner-state:${state.stateVersion}`;
    const complete = state.completeness.status === "complete" && !state.completeness.stale && state.summary.length <= 10;
    if (!complete) { out.status = "partial"; out.reason = state.completeness.stale ? "stale" : "truncated"; }
    out.data = [{ stateVersion: state.stateVersion, dataAsOf: state.dataAsOf, completeness: complete ? "complete" : "partial",
      limitations: state.completeness.gaps.slice(0, 16),
      summary: `当前读取 ${state.completeness.total} 条学习证据；展示 ${state.completeness.returned} 条；状态版本 ${state.stateVersion}；数据截止 ${state.dataAsOf}。`
        + state.summary.slice(0, 10).map(row => `${row.skillLabel.slice(0, 200)}：${row.sampleCount} 条记录，独立 ${row.views.independent}、保持 ${row.views.retention}、迁移 ${row.views.transfer}、帮助 ${row.views.help}（视角可重叠）。`).join("")
        + "这些计数不是掌握结论；未记录的协议、资格或曝光为证据缺口。" }];
  } else {
    const explained = await explainOpeningLearningDecision(tx, scope, request.arguments.decisionId);
    if (!explained) { out.status = "unknown"; out.reason = "no_data"; return; }
    const { decision, current, invalidationReasons } = explained;
    const refs = Object.entries(decision.sourceVersions).flatMap(([sourceId, versions]) => versions.map(sourceVersion => ({ sourceId, sourceVersion })));
    const [admitted] = await tx`SELECT ${contextSourceRefsIncluded(tx, scope.workspaceId, tx`${tx.json(refs)}::jsonb`, false)} AS included`;
    if (!admitted?.included) { out.status = "unknown"; out.reason = "stale"; return; }
    out.sourceRefs.push(...refs);
    out.asOf = explained.dataAsOf;
    if (!current) { out.status = "partial"; out.reason = "stale"; }
    out.data = [{ id: decision.id, current, basis: "persisted_decision", invalidationReasons: invalidationReasons.slice(0, 16),
      summary: `已保存的 ${decision.layer} 决策 ${decision.id}；记录于 ${decision.createdAt}，依据数据截止 ${decision.dataAsOf}；所选动作 ${decision.selectedAction.slice(0, 100)}；原始原因 ${decision.reasonCodes.join("、").slice(0, 2000)}。`
        + (current ? "当前版本核验通过。" : `当前适用性未确认：${invalidationReasons.join("、").slice(0, 2000)}；历史原因保留为历史，不作为当前重新计算的结论。`) }];
    out.evidence.push({ id: `decision:${decision.id}`, kind: "decision", recordId: decision.id, title: "已保存的决策依据", href: "/opening/today", revision: decision.stateVersion.slice(0, 100) });
  }
}
