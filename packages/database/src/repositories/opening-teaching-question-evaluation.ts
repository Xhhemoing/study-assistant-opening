import { repairDecodedLatexInJson } from "@aistudy/ai";
import type { Scope } from "@aistudy/contracts";
import { teachingQuestionInteractionSchema } from "@aistudy/contracts";
import { evaluateTeachingAnswer } from "@aistudy/domain";
import type { TransactionSql } from "postgres";
import { teachingQuestionBody, teachingQuestionIdentityMatches, teachingQuestionText, type TeachingQuestionSpec } from "./opening-teaching-question";

type Block = { id: string; type: string; content: Record<string, unknown> };

/** Only immutable server-side content can authorize a deterministic verdict. */
export async function evaluateOpeningTeachingKeyAttempt(tx: TransactionSql, scope: Scope,
  attempt: Record<string, unknown> | undefined, answer: string, _attemptSources: readonly Record<string, unknown>[]) {
  if (!attempt?.item_version_id || !(attempt.create_intent as { teachingBlock?: unknown } | null)?.teachingBlock) return null;
  const rows = await tx`SELECT v.evaluation_spec,r.blocks FROM opening_learning_item_versions v
    JOIN library_revisions r ON r.id=v.teaching_revision_id AND r.workspace_id=v.workspace_id
    WHERE v.id=${String(attempt.item_version_id)} AND v.problem_id=${String(attempt.problem_id)}
      AND v.workspace_id=${scope.workspaceId} AND v.owner_user_id=${scope.ownerUserId}
      AND ${teachingQuestionIdentityMatches(tx)} FOR SHARE OF v,r`;
  const row = rows[0];
  if (!row || !Array.isArray(row.blocks)) return null;
  const spec = row.evaluation_spec as TeachingQuestionSpec;
  if (spec?.kind !== "teaching_question" || spec.specVersion !== "teaching-question-v1" || !spec.answerBlockId) return null;
  const blocks = row.blocks as Block[];
  const prompt = blocks.find(block => block.id === spec.blockId && ["prompt", "question"].includes(block.type));
  if (prompt && repairDecodedLatexInJson(prompt.content).repairs > 0) return null;
  const key = blocks.find(block => block.id === spec.answerBlockId && ["answer_key", "solution"].includes(block.type));
  const body = teachingQuestionBody(prompt?.content);
  const interaction = teachingQuestionInteractionSchema.safeParse(prompt?.content?.interaction);
  if (!body || !interaction.success || !key) return null;
  const outcome = evaluateTeachingAnswer(body, interaction.data, teachingQuestionText(key.content), answer);
  if (!outcome || outcome === "unparseable") return null;
  const prior = await tx`SELECT o.id FROM opening_learning_observations o
    JOIN opening_learning_item_versions v ON v.id=o.item_version_id AND v.workspace_id=o.workspace_id AND v.owner_user_id=o.owner_user_id
    WHERE o.workspace_id=${scope.workspaceId} AND o.owner_user_id=${scope.ownerUserId} AND o.course_id=${String(attempt.course_id)}
      AND v.teaching_revision_id=${spec.revisionId} AND v.teaching_block_id=${spec.blockId}
      AND o.attempt_id<>${String(attempt.id)} AND o.verdict_source='deterministic'
      AND o.server_evaluation->>'evaluatorVersion'='teaching-key-exact-v1'
      AND o.server_evaluation->>'decision' IN ('correct','incorrect')
      AND o.recorded_at<=clock_timestamp() LIMIT 1`;
  return { evaluatorVersion: "teaching-key-exact-v1" as const, specVersion: "teaching-key-v1" as const,
    decision: outcome, outcome, reasonCodes: [outcome === "correct" ? "teaching_key_match" : "teaching_key_mismatch"], priorFeedback: prior.length > 0 };
}
