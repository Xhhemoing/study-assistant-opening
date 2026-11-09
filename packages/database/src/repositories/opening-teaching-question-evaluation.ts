import { isDeepStrictEqual } from "node:util";
import { repairDecodedLatexInJson, teachingBlindSolveMatchesCurrent } from "@aistudy/ai";
import type { Scope, TeachingBlockRef } from "@aistudy/contracts";
import { teachingQuestionInteractionSchema, teachingBlindSolveReceiptSchema, type TeachingBlindSolveIdentity } from "@aistudy/contracts";
import { compareCourseQuestionIdentity, evaluateTeachingAnswer } from "@aistudy/domain";
import type { TransactionSql } from "postgres";
import { evaluateOpeningTeachingReservedAttempt } from "./opening-teaching-reserved-evaluation";
import { readResolvedTeachingQuestion, teachingQuestionIdentityMatches, teachingQuestionText, type TeachingQuestionSpec } from "./opening-teaching-question";

type Block = { id: string; type: string; content: Record<string, unknown> };

/** Same pinned pair/text rules as attempt issuance; exact evaluation additionally needs reliable rendered text. */
export function resolveOpeningTeachingBlindSolveQuestion(blocks: Block[], blockOrder: TeachingBlockRef[], blockId: string) {
  const ordered = [...blockOrder].sort((a, b) => a.position - b.position);
  const index = ordered.findIndex(ref => ref.blockId === blockId && ref.role !== "answer_key"
    && (ref.role === "prompt" || ["prompt", "question"].includes(ref.blockType)));
  const prompt = blocks.find(block => block.id === blockId && ["prompt", "question"].includes(block.type));
  const following = ordered[index + 1];
  const key = index >= 0 && following && (following.role === "answer_key" || ["answer_key", "solution"].includes(following.blockType))
    ? blocks.find(block => block.id === following.blockId && ["answer_key", "solution"].includes(block.type)) : undefined;
  const interaction = teachingQuestionInteractionSchema.safeParse(prompt?.content.interaction).data;
  const reliable = index >= 0 && prompt && key && interaction && typeof prompt.content.text === "string" && !!prompt.content.text.trim()
    && repairDecodedLatexInJson(prompt.content).repairs === 0 && repairDecodedLatexInJson(key.content).repairs === 0;
  return { answerBlockId: key?.id ?? null, questionText: teachingQuestionText(prompt?.content), keyText: teachingQuestionText(key?.content),
    body: typeof prompt?.content.text === "string" ? prompt.content.text : "", interaction, reliable: !!reliable };
}

/** Read-only key metadata for a future non-deterministic evaluator. Never a learner verdict. */
export async function readOpeningTeachingBlindSolveKeyMetadata(tx: TransactionSql, scope: Scope, identity: TeachingBlindSolveIdentity) {
  const rows = await tx`SELECT j.result->'teachingBlindSolveReceipts'->${identity.blockId} AS receipt,r.blocks,s.block_order,s.source_refs
    FROM opening_jobs j
    JOIN opening_teaching_activity_specs s ON s.workspace_id=j.workspace_id AND s.owner_user_id=j.owner_user_id
      AND s.activity_id::text=j.payload->>'activityId'
    JOIN library_revisions r ON r.document_id=s.document_id AND r.workspace_id=s.workspace_id AND r.revision_number=s.revision_number
    JOIN opening_teaching_activities a ON a.id=s.activity_id AND a.workspace_id=s.workspace_id AND a.owner_user_id=s.owner_user_id
    WHERE j.workspace_id=${scope.workspaceId} AND j.owner_user_id=${scope.ownerUserId}
      AND j.kind='compile-teaching-unit' AND j.state='succeeded' AND s.activity_id=${identity.activityId}
      AND r.id=${identity.teachingRevisionId} AND s.version=${identity.contentVersion} AND a.content_version=s.version
      AND NOT EXISTS (SELECT 1 FROM jsonb_each_text(${tx.json(identity.sourceVersions as never)}) v
        WHERE NOT EXISTS (SELECT 1 FROM opening_sources source WHERE source.workspace_id=s.workspace_id
          AND source.id::text=v.key AND source.version::text=v.value
          AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=s.workspace_id AND e.source_id=source.id)))
    ORDER BY j.created_at DESC`;
  for (const row of rows) {
    const receipt = teachingBlindSolveReceiptSchema.safeParse(row.receipt);
    if (!receipt.success || !teachingBlindSolveMatchesCurrent(receipt.data, identity)
      || !Array.isArray(row.blocks) || !Array.isArray(row.block_order) || !Array.isArray(row.source_refs)) continue;
    const pinned = resolveOpeningTeachingBlindSolveQuestion(row.blocks as Block[], row.block_order as TeachingBlockRef[], identity.blockId);
    const sourceVersions: Record<string, number> = {};
    let versionsKnown = true;
    for (const ref of row.source_refs as Array<{ sourceId: string; version?: unknown }>) {
      const version = ref.version == null ? NaN : Number(ref.version);
      if (!Number.isSafeInteger(version) || version < 0 || (ref.sourceId in sourceVersions && sourceVersions[ref.sourceId] !== version)) versionsKnown = false;
      else sourceVersions[ref.sourceId] = version;
    }
    if (pinned.reliable && pinned.answerBlockId === identity.answerBlockId && pinned.questionText === identity.questionText
      && pinned.keyText === identity.keyText && versionsKnown && isDeepStrictEqual(sourceVersions, identity.sourceVersions)) {
      return { eligibility: "matched_current" as const, receipt: receipt.data };
    }
  }
  return { eligibility: "unknown" as const, receipt: null };
}

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
  if (spec?.kind !== "teaching_question" || spec.specVersion !== "teaching-question-v1") return null;
  if (!spec.answerBlockId) return evaluateOpeningTeachingReservedAttempt(tx, scope, attempt, spec, answer);
  const blocks = row.blocks as Block[];
  const prompt = blocks.find(block => block.id === spec.blockId && ["prompt", "question"].includes(block.type));
  if (prompt && repairDecodedLatexInJson(prompt.content).repairs > 0) return null;
  const key = blocks.find(block => block.id === spec.answerBlockId && ["answer_key", "solution"].includes(block.type));
  // The client displays a string `text` as the stem; it orders the other stem fields differently.
  const body = prompt?.content?.text;
  const interaction = teachingQuestionInteractionSchema.safeParse(prompt?.content?.interaction);
  if (!prompt || typeof body !== "string" || !body.trim() || !interaction.success || !key) return null;
  // Re-resolve the actual publication/pair. A valid-looking item JSON or another
  // answer block from the same document is not authority for a trusted verdict.
  const current = await readResolvedTeachingQuestion(tx, scope, spec, true);
  if (!current) return null;
  const outcome = evaluateTeachingAnswer(body, interaction.data, teachingQuestionText(key.content), answer);
  if (!outcome || outcome === "unparseable") return null;
  const prior = await tx`SELECT o.id,v.evaluation_spec,v.activity_id,v.teaching_block_id FROM opening_learning_observations o
    JOIN opening_learning_item_versions v ON v.id=o.item_version_id AND v.workspace_id=o.workspace_id AND v.owner_user_id=o.owner_user_id
    WHERE o.workspace_id=${scope.workspaceId} AND o.owner_user_id=${scope.ownerUserId} AND o.course_id=${String(attempt.course_id)}
      AND v.teaching_revision_id IS NOT NULL AND v.teaching_block_id IS NOT NULL
      AND ((v.activity_id=${spec.activityId} AND v.teaching_block_id=${spec.blockId})
        OR v.stem_snapshot=${teachingQuestionText(prompt.content)!.slice(0, 2000)})
      AND o.attempt_id<>${String(attempt.id)} AND o.verdict_source='deterministic'
      AND o.server_evaluation->>'evaluatorVersion'='teaching-key-exact-v1'
      AND o.server_evaluation->>'decision' IN ('correct','incorrect')
      AND o.recorded_at<=clock_timestamp()`;
  let priorFeedback = false;
  for (const previous of prior) {
    const previousSpec = previous.evaluation_spec as TeachingQuestionSpec | undefined;
    const resolved = previousSpec?.kind === "teaching_question" && previousSpec.specVersion === "teaching-question-v1"
      ? await readResolvedTeachingQuestion(tx, scope, previousSpec, true) : null;
    const match = compareCourseQuestionIdentity(current, resolved);
    const sameBinding = previous.activity_id === spec.activityId && previous.teaching_block_id === spec.blockId;
    // Key correctness is local to the pinned pair. Unrelated history must not
    // invalidate it. A broken binding for THIS question remains fail-closed.
    if (match === "conflict" || sameBinding && !resolved) return null;
    if (match === "same" || match === "equivalent_exact") priorFeedback = true;
    // Unknown/candidate is not deduplication or proof of unseen. Preserve the
    // local verdict, but conservatively withhold independent-attempt authority.
    if (match === "unknown" || match === "candidate") priorFeedback = true;
  }
  return { evaluatorVersion: "teaching-key-exact-v1" as const, specVersion: "teaching-key-v1" as const,
    decision: outcome, outcome, reasonCodes: [outcome === "correct" ? "teaching_key_match" : "teaching_key_mismatch"], priorFeedback };
}
