import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { Sql, TransactionSql } from "postgres";
import { aiEvaluationSchema, serverEvaluationSchema, aiGradingWorkSourceSchema, type StudyContextAnchor } from "@aistudy/contracts";
import type { OpeningScope } from "./opening-sources";
import { contextSourceRefsIncluded, mergeContextSourceRefs, type ContextSourceRef } from "./opening-context-provenance";
import { learningError } from "./opening-learning-facts";
import { resolveOpeningStudyContext } from "./opening-study-context";

type Db = Sql | TransactionSql;
export type TutorAttemptContextTarget = { userTurnId: string; jobId: string; claimToken?: string };
export type TutorAttemptContext = {
  privacyEpoch: number;
  anchor: StudyContextAnchor;
  originalQuestion: string;
  originalAnswer: { observationId: string; answer: string; answerRevision: number } | null;
  currentAnswer: { observationId: string; answer: string; answerRevision: number } | null;
  rootObservationId: string | null;
  headObservationId: string | null;
  workSource: { id: string; version: number; physicalPage: number } | null;
  effectiveGrading: { observationId: string; answerRevision: number; outcome: string; verdictSource: string;
    aiEvaluation: ReturnType<typeof aiEvaluationSchema.parse> | null;
    serverEvaluation: ReturnType<typeof serverEvaluationSchema.parse> | null } | null;
  sourceRefs: ContextSourceRef[];
};
export const tutorAttemptFenceSchema = z.object({
  attemptId: z.string().uuid(), itemVersionId: z.string().uuid(),
  rootObservationId: z.string().uuid().nullable(), headObservationId: z.string().uuid().nullable(),
  answerRevision: z.number().int().positive().nullable(),
}).strict();
export type TutorAttemptFence = z.infer<typeof tutorAttemptFenceSchema>;
export function tutorAttemptFence(snapshot: TutorAttemptContext): TutorAttemptFence {
  return tutorAttemptFenceSchema.parse({ attemptId: snapshot.anchor.attemptId, itemVersionId: snapshot.anchor.itemVersionId,
    rootObservationId: snapshot.rootObservationId, headObservationId: snapshot.headObservationId,
    answerRevision: snapshot.currentAnswer?.answerRevision ?? null });
}
const conflict = () => learningError("CONFLICT", "bound attempt context is unavailable or changed");

/** Resolve saved identities, never client-supplied answer/grade JSON. No ledger or grading writes. */
export async function readTutorAttemptContext(db: Db, scope: OpeningScope, target: TutorAttemptContextTarget): Promise<TutorAttemptContext | null> {
  const [turn] = await db`SELECT t.attempt_id,t.context_anchor,t.learning_session_id,c.course_id,w.privacy_epoch
    FROM opening_tutor_jobs j
    JOIN workspaces w ON w.id=j.workspace_id AND w.owner_user_id=${scope.ownerUserId}
    JOIN users u ON u.id=w.owner_user_id AND u.disabled_at IS NULL
    JOIN opening_conversations c ON c.id=j.conversation_id AND c.workspace_id=j.workspace_id AND c.owner_user_id=w.owner_user_id
    JOIN opening_turns t ON t.id=j.user_turn_id AND t.workspace_id=j.workspace_id AND t.conversation_id=j.conversation_id AND t.role='user'
    JOIN opening_turns a ON a.id=j.assistant_turn_id AND a.workspace_id=j.workspace_id AND a.conversation_id=j.conversation_id AND a.role='assistant'
      AND a.attempt_id IS NOT DISTINCT FROM t.attempt_id AND a.learning_session_id IS NOT DISTINCT FROM t.learning_session_id
    WHERE j.id=${target.jobId} AND j.user_turn_id=${target.userTurnId} AND j.workspace_id=${scope.workspaceId}
      AND j.status='running' AND j.claim_token IS NOT DISTINCT FROM ${target.claimToken ?? null}::uuid`;
  if (!turn) throw conflict();
  const saved = turn.context_anchor as StudyContextAnchor | null;
  const attemptId = turn.attempt_id ?? saved?.attemptId;
  if (!attemptId) return null;
  const anchor = await resolveOpeningStudyContext(db, scope, saved ?? { purpose: "learning_help", attemptId: String(attemptId) }, {
    courseId: turn.course_id as string | null, sessionId: turn.learning_session_id as string | null, attemptId: String(attemptId),
  });
  const [item] = await db`SELECT v.stem_snapshot,a.session_id,a.observation_id,a.submitted_at,a.source_ids,a.source_versions
    FROM opening_learning_attempts a JOIN opening_learning_item_versions v ON v.id=a.item_version_id
      AND v.workspace_id=a.workspace_id AND v.owner_user_id=a.owner_user_id AND v.problem_id=a.problem_id
    WHERE a.id=${String(attemptId)} AND a.workspace_id=${scope.workspaceId} AND a.owner_user_id=${scope.ownerUserId} FOR SHARE OF a,v`;
  if (!item || typeof item.stem_snapshot !== "string" || !item.stem_snapshot.trim()) throw conflict();
  const [chain] = item.observation_id ? await db`SELECT to_jsonb(root) AS original,to_jsonb(head) AS current,to_jsonb(previous) AS previous
    FROM opening_learning_observations root JOIN opening_learning_observations head
      ON head.id=COALESCE(root.effective_head_id,root.id) AND head.workspace_id=root.workspace_id AND head.owner_user_id=root.owner_user_id
      AND COALESCE(head.root_observation_id,head.id)=root.id
    LEFT JOIN opening_learning_observations previous ON previous.id=head.revises_observation_id
      AND previous.workspace_id=head.workspace_id AND previous.owner_user_id=head.owner_user_id
      AND COALESCE(previous.root_observation_id,previous.id)=root.id
    WHERE root.id=${item.observation_id} AND COALESCE(root.root_observation_id,root.id)=root.id
      AND root.workspace_id=${scope.workspaceId} AND root.owner_user_id=${scope.ownerUserId} FOR SHARE OF root,head` : [];
  const original = chain?.original as Record<string, unknown> | undefined;
  const head = chain?.current as Record<string, unknown> | undefined;
  if (item.submitted_at && (!original || !head)) throw conflict();
  for (const observation of [original, head]) {
    if (observation && (observation.attempt_id !== attemptId || observation.item_version_id !== anchor.itemVersionId
      || observation.course_id !== anchor.courseId || observation.session_id !== item.session_id
      || observation.revision_kind === "retract" || !Number.isSafeInteger(Number(observation.answer_revision)) || Number(observation.answer_revision) < 1)) throw conflict();
  }
  const photo = aiGradingWorkSourceSchema.nullable().safeParse(head?.grading_work_source ?? null);
  if (!photo.success) throw conflict();
  const workSource = photo.data;
  const sourceRefs = mergeContextSourceRefs(...[item, original, head].filter(Boolean).map(row => {
    const versions = (row!.source_versions ?? {}) as Record<string, number>;
    const ids = new Set([...(row!.source_ids as string[] ?? []), ...Object.keys(versions),
      ...(row!.reference_source_id ? [String(row!.reference_source_id)] : [])]);
    return [...ids].map(sourceId => {
      if (!Number.isSafeInteger(versions[sourceId])) throw conflict();
      return { sourceId, sourceVersion: versions[sourceId]! };
    });
  }), workSource ? [{ sourceId: workSource.id, sourceVersion: workSource.version }] : []);
  const [admitted] = await db`SELECT ${contextSourceRefsIncluded(db, scope.workspaceId, db`${db.json(sourceRefs)}::jsonb`, true, true)} AS included`;
  if (!admitted?.included) throw conflict();
  const unavailable = sourceRefs.length ? await db`SELECT ref FROM jsonb_array_elements(${db.json(sourceRefs)}::jsonb) ref
    JOIN opening_sources s ON s.id::text=ref->>'sourceId' AND s.workspace_id=${scope.workspaceId}
    WHERE s.version::text<>ref->>'sourceVersion'
      AND NOT EXISTS(SELECT 1 FROM opening_source_versions v WHERE v.source_id=s.id AND v.workspace_id=s.workspace_id
        AND v.version::text=ref->>'sourceVersion' AND v.availability='available')` : [];
  if (unavailable.length) throw conflict();
  // A sealed learner photo is answer provenance, not a course reference material.
  await resolveOpeningStudyContext(db, scope, anchor, { sourceIds: sourceRefs.filter(ref => ref.sourceId !== workSource?.id).map(ref => ref.sourceId) });
  let effectiveGrading: TutorAttemptContext["effectiveGrading"] = null;
  if (head) {
    const parsedAi = aiEvaluationSchema.nullable().safeParse(head.ai_evaluation ?? null);
    const parsedServer = serverEvaluationSchema.nullable().safeParse(head.server_evaluation ?? null);
    if (!parsedAi.success || !parsedServer.success) throw conflict();
    const ai = parsedAi.data, server = parsedServer.data;
    const previous = chain?.previous as Record<string, unknown> | null;
    if (ai && (!previous || previous.answer !== head.answer || previous.answer_revision !== head.answer_revision
      || ai.observationId !== head.id || ai.attemptId !== attemptId || ai.itemVersionId !== anchor.itemVersionId
      || ai.problemId !== head.problem_id || ai.outcome !== head.outcome || head.verdict_source !== "ai_graded"
      || !isDeepStrictEqual(ai.workSource ?? null, workSource))) throw conflict();
    if (server && (server.observationId !== head.id || server.attemptId !== attemptId || server.itemVersionId !== anchor.itemVersionId
      || server.problemId !== head.problem_id || server.outcome !== head.outcome || head.verdict_source !== "deterministic")) throw conflict();
    // Never search an ancestor for feedback: a changed answer must not inherit an old grade.
    if (ai || server) effectiveGrading = { observationId: String(head.id), answerRevision: Number(head.answer_revision),
      outcome: String(head.outcome), verdictSource: String(head.verdict_source), aiEvaluation: ai, serverEvaluation: server };
  }
  if (head && !String(head.answer ?? "").trim()
    && !(workSource && effectiveGrading?.aiEvaluation?.transcription?.trim())) {
    throw Object.assign(conflict(), { reasonCode: "ATTEMPT_ANSWER_TEXT_UNAVAILABLE" });
  }
  const answer = (row: Record<string, unknown> | undefined) => row ? { observationId: String(row.id),
    answer: String(row.answer), answerRevision: Number(row.answer_revision) } : null;
  return { privacyEpoch: Number(turn.privacy_epoch), anchor, originalQuestion: item.stem_snapshot,
    originalAnswer: answer(original), currentAnswer: answer(head), rootObservationId: original ? String(original.id) : null,
    headObservationId: head ? String(head.id) : null, workSource, effectiveGrading, sourceRefs };
}

export async function assertTutorAttemptContext(db: Db, scope: OpeningScope, target: TutorAttemptContextTarget, expected: TutorAttemptContext) {
  if (!isDeepStrictEqual(await readTutorAttemptContext(db, scope, target), expected)) throw conflict();
}
