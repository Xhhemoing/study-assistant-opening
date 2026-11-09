import { isDeepStrictEqual } from "node:util";
import type { Scope, TeachingBlockRef } from "@aistudy/contracts";
import { courseRouteActivityContextSchema, teachingQuestionInteractionSchema } from "@aistudy/contracts";
import { evaluateTeachingAnswer } from "@aistudy/domain";
import type { Sql, TransactionSql } from "postgres";
import { readOpeningReservedKey } from "./opening-course-reserved-selection";
import { assertCourseReservedReplay } from "./opening-course-route-reserved-start";
import { reservedArithmeticIdentity } from "./opening-reserved-arithmetic-identity";
import { learningError } from "./opening-learning-facts";
import type { TeachingQuestionSpec } from "./opening-teaching-question";

type Block = { id: string; type: string; content: Record<string, unknown> };

/** Private keys are selected ONLY by the actual attempt's issued item, never spec JSON.
 * The public pair resolver cannot represent prompt-only private questions. Until its
 * history consumers support that identity, this verdict cannot grant independence.
 */
export async function evaluateOpeningTeachingReservedAttempt(tx: TransactionSql, scope: Scope,
  attempt: Record<string, unknown>, spec: TeachingQuestionSpec, answer: string) {
  if (spec.answerBlockId !== null || Object.keys(spec).some(field => !["kind", "specVersion", "activityId", "teachingUnitId",
    "contentVersion", "documentId", "revisionId", "revisionNumber", "blockId", "answerBlockId", "sourceRefs", "courseRequirement"].includes(field))) return null;
  const [row] = await tx`SELECT v.evaluation_spec,v.stem_snapshot,r.blocks,s.block_order,s.source_refs,a.*,
      q.requirement_id AS reserved_requirement_id,q.requirement_revision AS reserved_requirement_revision
    FROM opening_course_reserved_questions q
    JOIN opening_learning_item_versions v ON v.id=q.issued_item_version_id AND v.workspace_id=q.workspace_id AND v.owner_user_id=q.owner_user_id
      AND v.activity_id=q.reserved_activity_id
    JOIN opening_teaching_activities a ON a.id=v.activity_id AND a.workspace_id=v.workspace_id AND a.owner_user_id=v.owner_user_id
    JOIN opening_teaching_activity_specs s ON s.activity_id=a.id AND s.workspace_id=a.workspace_id AND s.owner_user_id=a.owner_user_id
    JOIN opening_teaching_units u ON u.id=s.teaching_unit_id AND u.workspace_id=s.workspace_id AND u.owner_user_id=s.owner_user_id AND u.document_id=s.document_id
    JOIN library_revisions r ON r.id=v.teaching_revision_id AND r.workspace_id=v.workspace_id
      AND r.document_id=s.document_id AND r.revision_number=s.revision_number
    JOIN library_documents d ON d.id=r.document_id AND d.workspace_id=r.workspace_id
    WHERE q.workspace_id=${scope.workspaceId} AND q.owner_user_id=${scope.ownerUserId} AND q.state='issued'
      AND v.id=${String(attempt.item_version_id)} AND v.problem_id=${String(attempt.problem_id)}
      AND a.id=${spec.activityId} AND a.course_id=${String(attempt.course_id)} AND q.course_id=a.course_id
      AND a.status='active' AND a.content_version=${spec.contentVersion} AND s.version=a.content_version
      AND s.teaching_unit_id=${spec.teachingUnitId} AND s.document_id=${spec.documentId}
      AND r.id=${spec.revisionId} AND r.revision_number=${spec.revisionNumber}
      AND v.teaching_block_id=${spec.blockId} AND r.lifecycle='published' AND d.lifecycle='published'
      AND d.current_revision_number=r.revision_number FOR SHARE OF q,v,a,s,u,r,d`;
  if (!row || !isDeepStrictEqual(row.evaluation_spec, spec) || !Array.isArray(row.blocks) || !Array.isArray(row.block_order)) return null;
  // Issuance publishes exactly one prompt. Reject shadow bodies, extra conditions,
  // interactions or keys rather than silently dropping data from the public stem.
  const blocks = row.blocks as Block[], order = row.block_order as TeachingBlockRef[];
  if (blocks.length !== 1 || order.length !== 1 || order[0]?.blockId !== spec.blockId
    || order[0].role !== "prompt" || order[0].blockType !== "prompt" || order[0].position !== 0) return null;
  const prompt = blocks[0];
  if (!prompt || prompt.id !== spec.blockId || prompt.type !== "prompt" || !prompt.content
    || Object.keys(prompt.content).some(field => !["text", "interaction"].includes(field))) return null;
  const body = prompt.content.text, interaction = teachingQuestionInteractionSchema.safeParse(prompt.content.interaction);
  if (typeof body !== "string" || !interaction.success || interaction.data.kind !== "numeric" || interaction.data.unit !== undefined
    || row.stem_snapshot !== body || !reservedArithmeticIdentity(body)) return null;
  const privateKey = await readOpeningReservedKey(tx, scope, String(attempt.item_version_id));
  if (!privateKey || privateKey.text !== body || !isDeepStrictEqual(privateKey.interaction, interaction.data)
    || !isDeepStrictEqual(privateKey.sourceRefs, row.source_refs) || !isDeepStrictEqual(spec.sourceRefs, row.source_refs)) return null;
  const binding = spec.courseRequirement;
  if (!binding || binding.id !== row.reserved_requirement_id || binding.revision !== Number(row.reserved_requirement_revision)
    || binding.requirementKey !== "arithmetic") return null;
  const goal = row.goal_json as { courseRoute?: unknown; reservedStart?: { taskId?: string; taskVersion?: number };
    learningBudget?: { minutes?: number } } | null;
  const route = courseRouteActivityContextSchema.safeParse(goal?.courseRoute).data, receipt = goal?.reservedStart;
  const minutes = goal?.learningBudget?.minutes;
  if (!route || !receipt || typeof receipt.taskId !== "string" || typeof receipt.taskVersion !== "number" || !Number.isSafeInteger(receipt.taskVersion)
    || typeof minutes !== "number" || !Number.isSafeInteger(minutes) || minutes < 5 || minutes > 180
    || route.requirementId !== binding.id || route.requirementRevision !== binding.revision
    || route.stableSkillId !== binding.stableSkillId || route.requirementKey !== binding.requirementKey) return null;
  const [bindingRow] = await tx`SELECT requirement.id FROM course_requirements requirement
    JOIN opening_retest_activities retest ON retest.id=${route.retestId ?? null} AND retest.course_id=requirement.course_id
      AND retest.workspace_id=requirement.workspace_id AND retest.owner_user_id=requirement.owner_user_id
    WHERE requirement.id=${binding.id} AND requirement.workspace_id=${scope.workspaceId} AND requirement.owner_user_id=${scope.ownerUserId}
      AND requirement.verification->>'kind'='exact' AND retest.task_id=${receipt.taskId}
      AND retest.task_id::text=${(row.create_intent as { taskId?: string })?.taskId ?? null}
      AND retest.learning_protocol->>'protocolId'='course-route-delayed-v1'
      AND retest.learning_protocol->>'goalId'=${route.goalId}
      AND retest.learning_protocol->>'requirementId'=${binding.id}
      AND retest.learning_protocol->>'stableSkillId'=${binding.stableSkillId} FOR SHARE OF requirement,retest`;
  if (!bindingRow) throw learningError("CONFLICT", "保留复测的原始任务或要求绑定已变化。");
  // Reuse the ORIGINAL receipt: full current protocol, task version and purpose
  // CAS checks run under the submit transaction. Never capture a replacement pin.
  await assertCourseReservedReplay(tx as unknown as Sql, tx, scope, String(attempt.course_id), row, {
    goalId: route.goalId, expectedGoalRevision: route.goalRevision, requirementId: binding.id,
    expectedRequirementRevision: binding.revision, taskId: receipt.taskId, expectedTaskVersion: receipt.taskVersion,
    minutes, clientKey: "reserved-evaluation",
  });
  // The existing evaluator checks the private key against the entire arithmetic
  // expression. Math delimiters preserve literal '*' when evaluating its grammar.
  const exact = reservedArithmeticIdentity(body)!;
  const outcome = evaluateTeachingAnswer(`$${exact.expression}$`, interaction.data, privateKey.answer, answer);
  if (!outcome || outcome === "unparseable") return null;
  return { evaluatorVersion: "teaching-key-exact-v1" as const, specVersion: "teaching-key-v1" as const,
    decision: outcome, outcome, reasonCodes: [outcome === "correct" ? "teaching_key_match" : "teaching_key_mismatch"],
    priorFeedback: true };
}
