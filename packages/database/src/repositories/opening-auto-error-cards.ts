import { randomUUID } from "node:crypto";
import { isMaterialItemDisputed } from "./opening-material-questions";
import type { Sql, TransactionSql } from "postgres";
import { aiEvaluationSchema, type Scope } from "@aistudy/contracts";
import { acceptedAiGradingOutcome, createInitialState, matrixErrorCardReference, solveSpanProblemWithSteps } from "@aistudy/domain";
import { captureOpeningObservationCardOrigin } from "./opening-card-drafts";
import { parseOpeningSpanExercise } from "./opening-span-attempt";
import { writeState } from "./cards-ops";

/** Called under the observation transaction's workspace/root locks. Manual cards have no origin root. */
export async function syncOpeningAutomaticErrorCard(tx: TransactionSql, scope: Scope, observationId: string): Promise<void> {
  const [head] = await tx`SELECT o.* FROM opening_learning_observations o
    JOIN opening_learning_observations root ON root.id=COALESCE(o.root_observation_id,o.id)
      AND root.workspace_id=o.workspace_id AND root.owner_user_id=o.owner_user_id
    WHERE o.id=${observationId} AND o.workspace_id=${scope.workspaceId} AND o.owner_user_id=${scope.ownerUserId}
      AND COALESCE(root.effective_head_id,root.id)=o.id`;
  if (!head) return;
  const rootId = String(head.root_observation_id ?? head.id);
  const assessment = aiEvaluationSchema.safeParse(head.ai_evaluation);
  const validAi = head.verdict_source === "ai_graded" && assessment.success && assessment.data.observationId === head.id
    && acceptedAiGradingOutcome(assessment.data) === "incorrect";
  const server = head.server_evaluation as { observationId?: string; outcome?: string } | null;
  const deterministic = head.verdict_source === "deterministic" && server?.observationId === head.id && server?.outcome === "incorrect";
  let reference: string | null = null;
  if (deterministic) {
    const [item] = await tx`SELECT evaluation_spec FROM opening_learning_item_versions
      WHERE id=${head.item_version_id} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
    reference = matrixErrorCardReference(item?.evaluation_spec);
    const span = parseOpeningSpanExercise(item?.evaluation_spec);
    if (span) {
      const solution = solveSpanProblemWithSteps(span);
      reference = `将两个向量和目标向量组成增广矩阵，检查每个坐标。\n行化简结果：${JSON.stringify(solution.reducedMatrix)}\n答案：${JSON.stringify(solution.solution)}`;
    }
  }
  const canCreate = head.revision_kind !== "retract" && head.outcome === "incorrect" && (validAi || reference !== null)
    && !await isMaterialItemDisputed(tx,scope,head.item_version_id as string | null);
  if (!canCreate) {
    await tx`UPDATE cards SET auto_paused=true,updated_at=now()
      WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND origin_observation_root_id=${rootId}`;
    return;
  }
  const { draft, sourceIds } = await captureOpeningObservationCardOrigin(tx, scope, observationId);
  const back = (validAi && assessment.success ? ["AI 批改反馈", assessment.data.feedback,
    ...assessment.data.criteria.map(criterion => `${criterion.label}：${criterion.feedback}`),
    draft.back ? `参考材料：\n${draft.back}` : ""].filter(Boolean).join("\n\n") : reference!).slice(0, 4000);
  const id = randomUUID();
  const [card] = await tx`INSERT INTO cards(id,workspace_id,owner_user_id,front,back,course_id,skill_label,source_ids,tags,origin_observation_root_id)
    VALUES(${id},${scope.workspaceId},${scope.ownerUserId},${draft.front},${back},${draft.courseId},${draft.skillLabel},${sourceIds},${["错题"]},${rootId})
    ON CONFLICT(workspace_id,owner_user_id,origin_observation_root_id) DO UPDATE SET
      front=EXCLUDED.front,back=EXCLUDED.back,course_id=EXCLUDED.course_id,skill_label=EXCLUDED.skill_label,
      source_ids=EXCLUDED.source_ids,auto_paused=false,content_version=cards.content_version+1,updated_at=now()
    RETURNING id`;
  // Content corrections do not erase reviews or recreate an existing card.
  if (String(card!.id) === id) await writeState(tx as Sql, scope.workspaceId, scope.ownerUserId, createInitialState(id, new Date()));
}
