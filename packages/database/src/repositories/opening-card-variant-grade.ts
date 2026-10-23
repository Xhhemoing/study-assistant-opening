import { isDeepStrictEqual } from "node:util";
import { cardReviewKind, type Scope } from "@aistudy/contracts";
import type { Sql } from "postgres";
import { gradeCard } from "./cards-grade";
import { loadCard, loadReviewStateForUpdate, lockCardForUpdate } from "./cards-ops";
import { learningError, lockWorkspaceLearningHistory } from "./opening-learning-facts";
import { qualifyObservationRevision } from "./opening-observation-revision-history";
import { proposalTransactionClient } from "./opening-assistant-proposal-effects";

/** An accepted answer to the current new question is the only authority for this FSRS update. */
export async function gradeCardVariant(sql: Sql, scope: Scope, cardId: string, observationId: string) {
  return sql.begin(async tx => {
    await lockWorkspaceLearningHistory(tx, scope);
    await lockCardForUpdate(tx as Sql, scope.workspaceId, scope.ownerUserId, cardId);
    const card = await loadCard(tx as Sql, scope.workspaceId, cardId);
    const [row] = await tx`SELECT o.*,root.effective_head_id AS current_head_id,
        a.started_at AS attempt_started_at,a.submitted_at AS attempt_submitted_at,
        t.id AS variant_id,t.create_intent AS variant_intent,t.course_id AS variant_course_id,t.generate_status,
        v.activity_id AS item_activity_id,v.teaching_revision_id,v.teaching_block_id,v.evaluation_spec,t.content_version AS activity_content_version
      FROM opening_learning_observations o
      JOIN opening_learning_observations root ON root.id=COALESCE(o.root_observation_id,o.id)
        AND root.workspace_id=o.workspace_id AND root.owner_user_id=o.owner_user_id
      JOIN opening_learning_attempts a ON a.id=o.attempt_id AND a.workspace_id=o.workspace_id AND a.owner_user_id=o.owner_user_id
        AND a.session_id=o.session_id AND a.problem_id=o.problem_id AND a.item_version_id=o.item_version_id
      JOIN opening_learning_item_versions v ON v.id=a.item_version_id AND v.workspace_id=o.workspace_id AND v.owner_user_id=o.owner_user_id
      JOIN opening_teaching_activities t ON t.id=v.activity_id AND t.workspace_id=o.workspace_id AND t.owner_user_id=o.owner_user_id
      JOIN courses c ON c.id=o.course_id AND c.workspace_id=o.workspace_id AND c.archived_at IS NULL
      WHERE o.id=${observationId} AND o.workspace_id=${scope.workspaceId} AND o.owner_user_id=${scope.ownerUserId}`;
    const intent = row?.variant_intent;
    if (!row || cardReviewKind(card) !== "question" || card.archived || card.autoPaused
      || intent?.kind !== "card_review_variant" || intent.cardId !== cardId || intent.cardContentVersion !== card.contentVersion
      || row.variant_course_id !== card.courseId || row.course_id !== card.courseId || row.activity_id !== row.variant_id
      || !row.teaching_revision_id || row.teaching_revision_id !== intent.variantRevisionId || row.teaching_block_id !== intent.variantBlockId
      || row.evaluation_spec?.kind !== "teaching_question" || row.evaluation_spec?.contentVersion !== intent.variantContentVersion
      || Number(row.activity_content_version) !== intent.variantContentVersion
      || row.current_head_id !== row.id || row.revision_kind === "retract" || row.generate_status !== "ready") {
      throw learningError("CONFLICT", "请完成这张卡片当前的变式后继续。");
    }
    const observation = await qualifyObservationRevision(tx, scope, row);
    if (observation.eligibility?.usableForCurrentVersion !== "yes"
      || !["correct", "incorrect"].includes(observation.outcome)
      || !["ai_graded", "deterministic"].includes(observation.verdictSource)
      || observation.verdictSource === "ai_graded" && observation.aiEvaluation?.outcome !== observation.outcome) {
      throw learningError("CONFLICT", "这道题还在等待批改，请查看批改结果后继续。");
    }
    const [workspace] = await tx`SELECT privacy_epoch FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
    const sources = card.sourceDocumentId || observation.sourceIds.length ? await tx`SELECT id,version FROM opening_sources
      WHERE workspace_id=${scope.workspaceId} AND id=ANY(${Object.keys(intent.sourceVersions ?? {})}::uuid[])` : [];
    if (Number(workspace?.privacy_epoch) !== intent.privacyEpoch || !isDeepStrictEqual(intent.sourceVersions,
      Object.fromEntries(sources.map(source => [String(source.id), Number(source.version)])))) throw learningError("CONFLICT", "材料已更新，请回到复习列表继续。");
    const idempotencyKey = `card-variant-review:${String(row.variant_id)}`;
    const [existing] = await tx`SELECT id FROM learning_events WHERE workspace_id=${scope.workspaceId}
      AND owner_user_id=${scope.ownerUserId} AND idempotency_key=${idempotencyKey}`;
    const state = await loadReviewStateForUpdate(tx as Sql, scope.workspaceId, scope.ownerUserId, cardId);
    if (!existing && intent.reviewReps !== (state?.reps ?? 0)) throw learningError("CONFLICT", "这张卡片的复习已更新，请返回列表继续。");
    const chain = await tx`SELECT id,revises_observation_id,answer,recorded_at FROM opening_learning_observations
      WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
        AND COALESCE(root_observation_id,id)=${String(row.root_observation_id ?? row.id)}`;
    const byId = new Map(chain.map(item => [String(item.id), item]));
    let answerAt = new Date(row.attempt_submitted_at).getTime();
    let answerRevision = byId.get(String(row.id));
    const visited = new Set<string>();
    while (answerRevision?.revises_observation_id) {
      if (visited.has(String(answerRevision.id))) throw learningError("CONFLICT", "作答记录有更新，请刷新后继续。");
      visited.add(String(answerRevision.id));
      const previous = byId.get(String(answerRevision.revises_observation_id));
      if (!previous) throw learningError("CONFLICT", "作答记录有更新，请刷新后继续。");
      if (answerRevision.answer !== previous.answer) { answerAt = new Date(answerRevision.recorded_at).getTime(); break; }
      answerRevision = previous;
    }
    const elapsed = answerAt - new Date(row.attempt_started_at).getTime();
    if (!Number.isFinite(elapsed) || elapsed < 0 || !row.attempt_submitted_at) throw learningError("CONFLICT", "尚未完成这道题，请先提交作答。");
    const assisted = observation.eligibility?.independentAttempt !== "yes";
    const expectedMs = Math.max(1, Number(intent.estimatedMinutes) || 5) * 60_000;
    const grade = observation.outcome === "incorrect" ? "again" : assisted || elapsed > expectedMs * 2 ? "hard" : elapsed <= expectedMs ? "easy" : "good";
    return gradeCard(proposalTransactionClient(tx), { ...scope, cardId, grade, assisted, idempotencyKey,
      occurredAt: new Date().toISOString(), variantObservationId: observationId });
  });
}
