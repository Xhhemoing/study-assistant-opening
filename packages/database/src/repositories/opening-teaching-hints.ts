import type { Sql, TransactionSql } from "postgres";
import { teachingPartialHintsSchema, type Scope, type TeachingAnswerKey, type TeachingBlockRef, type TeachingHintLevel, type TeachingHintResponse, type TeachingSourceRef } from "@aistudy/contracts";
import { admitLearningSources, learningError, lockLearningOwner, lockWorkspaceLearningHistory } from "./opening-learning-facts";
import { generateOpeningStudyExposure, releaseOpeningStudyExposure } from "./opening-study-exposure";

type Question = {
  attemptId: string; activityId: string; blockId: string; contentVersion: number;
  courseId: string; sessionId: string; itemVersionId: string | null;
  answer: string | null; referenceSourceId: string | null; hints: unknown;
};

/** Resolve only the bound question and its adjacent hidden answer at the pinned revision.
 * Workspace lock precedes activity/attempt locks, matching answer/exposure writes. */
async function readQuestion(tx: TransactionSql, scope: Scope,
  input: { attemptId: string; activityId?: string; blockId?: string }, requireSubmitted: boolean): Promise<Question> {
  await lockWorkspaceLearningHistory(tx, scope);
  await lockLearningOwner(tx, scope);
  const [attempt] = await tx`SELECT * FROM opening_learning_attempts WHERE id=${input.attemptId}
    AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR SHARE`;
  if (!attempt || requireSubmitted && !attempt.submitted_at) throw learningError("NOT_FOUND", "submitted teaching attempt not found");
  const intent = attempt.create_intent as { teachingBlock?: { blockId?: unknown; contentVersion?: unknown } };
  const binding = intent.teachingBlock;
  if (!binding || typeof binding.blockId !== "string" || !Number.isInteger(binding.contentVersion)) throw learningError("VALIDATION", "attempt is not a teaching question");
  if (input.activityId && attempt.activity_id !== input.activityId) throw learningError("NOT_FOUND", "submitted teaching attempt not found");
  if (input.blockId && binding.blockId !== input.blockId) throw learningError("VALIDATION", "attempt does not belong to this teaching question");
  const activityId = String(attempt.activity_id), blockId = binding.blockId, contentVersion = Number(binding.contentVersion);
  const [activity] = await tx`SELECT a.* FROM opening_teaching_activities a
    JOIN workspaces w ON w.id=a.workspace_id AND w.owner_user_id=${scope.ownerUserId}
    WHERE a.id=${activityId} AND a.workspace_id=${scope.workspaceId} AND a.owner_user_id=${scope.ownerUserId} FOR SHARE OF a`;
  if (!activity) throw learningError("NOT_FOUND", "teaching activity not found");
  if (Number(activity.content_version) !== contentVersion) throw learningError("CONFLICT", "teaching content changed; the attempt belongs to an earlier version");
  const admitted = await admitLearningSources(tx, scope, activity.source_ids as string[]);
  const currentVersions = new Map(admitted.map(source => [String(source.id), Number(source.version)]));
  const [spec] = await tx`SELECT * FROM opening_teaching_activity_specs WHERE activity_id=${activityId}
    AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR SHARE`;
  if (!spec) throw learningError("NOT_FOUND", "teaching content not found");
  if (Number(spec.version) !== contentVersion) throw learningError("CONFLICT", "teaching specification version changed");
  const capturedVersions = attempt.source_versions as Record<string, number>;
  const sourceRefs = spec.source_refs as TeachingSourceRef[];
  for (const ref of sourceRefs) {
    const version = ref.version == null ? NaN : Number(ref.version);
    if (Number.isInteger(version) && (currentVersions.get(ref.sourceId) !== version || capturedVersions[ref.sourceId] !== version)) {
      throw learningError("CONFLICT", "teaching reference material version changed; reread the teaching content");
    }
  }
  const ordered = [...spec.block_order as TeachingBlockRef[]].sort((a, b) => a.position - b.position);
  const index = ordered.findIndex(block => block.blockId === blockId && (block.role === "prompt" || block.blockType === "question" || block.blockType === "prompt"));
  if (index < 0) throw learningError("VALIDATION", "teaching question not found");
  const following = ordered[index + 1];
  let body: Record<string, unknown> | undefined;
  if (following && (following.role === "answer_key" || following.blockType === "answer_key" || following.blockType === "solution")) {
    const [revision] = await tx`SELECT blocks FROM library_revisions WHERE workspace_id=${scope.workspaceId}
      AND document_id=${spec.document_id} AND revision_number=${spec.revision_number}`;
    if (!revision) throw learningError("NOT_FOUND", "teaching revision not found");
    body = (revision.blocks as Array<{ id: string; content: Record<string, unknown> }>).find(row => row.id === following.blockId)?.content;
  }
  const answer = body && [body.text, body.markdown, body.answer, body.solution].find((value): value is string => typeof value === "string" && Boolean(value.trim()));
  const ownCitations = new Set(Array.isArray(body?.citedChunkIds) ? body.citedChunkIds.filter((id): id is string => typeof id === "string") : []);
  const candidates = sourceRefs.filter(ref => ref.chunkId && ownCitations.has(ref.chunkId)
    && ref.version != null && Number.isInteger(Number(ref.version))
    && capturedVersions[ref.sourceId] === Number(ref.version) && currentVersions.get(ref.sourceId) === Number(ref.version));
  const chunks = candidates.length ? await tx`SELECT c.id,c.source_id,c.source_version FROM opening_source_chunks c
    JOIN opening_sources s ON s.id=c.source_id WHERE s.workspace_id=${scope.workspaceId}
      AND c.id::text=ANY(${candidates.map(ref => ref.chunkId!)}::text[]) FOR SHARE OF c,s` : [];
  const reference = candidates.find(ref => chunks.some(chunk => String(chunk.id) === ref.chunkId
    && String(chunk.source_id) === ref.sourceId && Number(chunk.source_version) === Number(ref.version)));
  return { attemptId: input.attemptId, activityId, blockId, contentVersion, courseId: String(attempt.course_id),
    sessionId: String(attempt.session_id), itemVersionId: attempt.item_version_id == null ? null : String(attempt.item_version_id),
    answer: answer?.slice(0, 20_000) ?? null, referenceSourceId: reference?.sourceId ?? null, hints: body?.hints };
}

async function release(tx: TransactionSql, scope: Scope, question: Question, level: TeachingHintLevel) {
  const full = level === 4;
  const generated = await generateOpeningStudyExposure(tx, scope, {
    releaseKey: `teaching-hint-v1:${question.attemptId}:${level}`,
    contextAnchor: { attemptId: question.attemptId, itemVersionId: question.itemVersionId, courseId: question.courseId,
      activityId: question.activityId, blockId: question.blockId, contentVersion: question.contentVersion,
      purpose: full ? "history_solution" : "learning_help" },
    sessionId: question.sessionId, origin: full ? "history_solution" : "assistant",
    kind: full ? "solution" : "hint", level: full ? "revealed" : "hinted", supportDomain: "unknown",
  });
  return releaseOpeningStudyExposure(tx, scope, generated.id);
}

/** Existing answer-key readers share level-four qualification and the same release key. */
export async function readOpeningTeachingAnswerKey(tx: TransactionSql, scope: Scope,
  activityId: string, blockId: string, attemptId: string): Promise<TeachingAnswerKey> {
  const question = await readQuestion(tx, scope, { activityId, blockId, attemptId }, true);
  if (question.answer) await release(tx, scope, question, 4);
  return { answer: question.answer, referenceSourceId: question.referenceSourceId };
}

export function createOpeningTeachingHintRepository(sql: Sql) {
  return { read: (scope: Scope, input: { attemptId: string; level: TeachingHintLevel }): Promise<TeachingHintResponse> => sql.begin(async tx => {
    const question = await readQuestion(tx, scope, input, input.level === 4);
    let text: string;
    if (input.level === 4) {
      if (!question.answer) throw learningError("CONFLICT", "此题没有可读取的完整参考答案；原作答已保留，仍可继续学习。");
      text = question.answer;
    } else {
      const hints = teachingPartialHintsSchema.safeParse(question.hints);
      if (!hints.success) throw learningError("CONFLICT", "此版教学内容没有分级提示，仍可提交作答；需要提示时请重新生成教学内容。");
      text = hints.data[({ 1: "direction", 2: "concept", 3: "firstStep" } as const)[input.level]];
    }
    // No release row is written until a real, validated response is available.
    const exposureReceipt = await release(tx, scope, question, input.level);
    return { attemptId: input.attemptId, level: input.level, text, exposureReceipt,
      referenceSourceId: input.level === 4 ? question.referenceSourceId : null };
  }) as Promise<TeachingHintResponse> };
}
