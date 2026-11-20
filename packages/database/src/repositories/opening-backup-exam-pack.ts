import { isDeepStrictEqual } from "node:util";
import { courseExamSnapshotSchema, type ExamCourseBinding, type ExamPack, type ExamQuestion, type ExamSprintState, type Scope } from "@aistudy/contracts";
import { EXAM_SPRINT_PACK } from "@aistudy/domain/exam-sprint-catalog";
import type { TransactionSql } from "postgres";
import { buildExamChoiceSpec } from "./opening-exam-integration-evaluation";
import { parseExamBinding } from "./opening-exam-skill-identity";
import { parseExamSprintSnapshot } from "./opening-exam-sprint-snapshot";

type Row = Record<string, unknown>;
const catalogReference = { id: EXAM_SPRINT_PACK.id, version: EXAM_SPRINT_PACK.version };

/** Learner recovery preserves catalog identity and request history. The target supplies
 * the exact catalog version. Generated papers, rubrics and teaching revisions are
 * omitted because an empty target cannot reconstruct their private publication. */
export function exportSprintPack(row: Row): Row {
  if (row.course_id != null) {
    const pack = courseExamSnapshotSchema.parse(row.pack_snapshot);
    // Keep the learner's request, source and identity. A ready request requires its
    // private answer-bearing proposal; importing it cannot certify a ready publication.
    return { ...row, state: {}, pack_snapshot: { ...pack, requests: pack.requests.map(request =>
      request.status === "pending" || request.status === "ready"
        ? { ...request, status: "unknown", proposal: null, activityId: null } : request) } };
  }
  const { pack, state } = parseExamSprintSnapshot(row.pack_snapshot, row.state);
  if (!isDeepStrictEqual(pack, EXAM_SPRINT_PACK)) throw new Error("Frozen sprint pack does not match the trusted restore catalog");
  const sealed = new Set(state.runs.filter(run => (run.mode === "mock-a" || run.mode === "mock-b") && run.completedAt === null).map(run => run.id));
  for (const attempt of state.attempts) {
    delete attempt.resultMetadata;
    if (sealed.has(attempt.runId)) {
      attempt.correct = null;
      delete attempt.prediction;
    }
  }
  return { ...row, pack_snapshot: catalogReference, state };
}

export function restoreSprintPack(row: Row): Row {
  if (row.course_id != null) {
    const pack = courseExamSnapshotSchema.parse(row.pack_snapshot);
    if (!isDeepStrictEqual(row.state, {}) || pack.requests.some(request => request.proposal !== null || request.status === "pending")) {
      throw new Error("Private or pending exam request in learner backup");
    }
    return row;
  }
  if (!isDeepStrictEqual(row.pack_snapshot, catalogReference)) throw new Error("Unrecognized sprint catalog reference");
  // Keep mock run and attempt identities for linked history, but an archive cannot
  // authenticate a graded submission. An imported mock is closed and ungraded.
  const incoming = structuredClone(row.state) as Partial<ExamSprintState> | null;
  if (!incoming || !Array.isArray(incoming.runs) || !Array.isArray(incoming.attempts)) throw new Error("Invalid sprint history");
  const mocks = new Map(incoming.runs.filter(run => run.mode === "mock-a" || run.mode === "mock-b").map(run => [run.id, run]));
  for (const attempt of incoming.attempts) {
    const mock = mocks.get(attempt.runId);
    if (mock) {
      if (mock.completedAt === null && attempt.correct !== null) throw new Error("Sealed mock result in learner archive");
      attempt.answer = null;
      attempt.answeredAt = null;
      attempt.correct = null;
      attempt.confidence = null;
      attempt.durationSeconds = null;
      delete attempt.prediction;
    }
    attempt.firstFamilyExposure = false;
  }
  const { pack, state } = parseExamSprintSnapshot(EXAM_SPRINT_PACK, incoming);
  for (const run of state.runs) {
    if (mocks.has(run.id) && run.completedAt === null) {
      run.completedAt = state.attempts.filter(attempt => attempt.runId === run.id).reduce(
        (last, attempt) => Date.parse(attempt.presentedAt) > Date.parse(last) ? attempt.presentedAt : last, run.startedAt);
    }
  }
  if (state.attempts.some(attempt => attempt.resultMetadata !== undefined)) throw new Error("Private exam result in learner backup");
  return { ...row, pack_snapshot: pack, state };
}

async function restorePendingChoice(tx: TransactionSql, scope: Scope, sprintId: string, attemptId: string,
  activityKey: string, pack: ExamPack, question: ExamQuestion, binding: ExamCourseBinding): Promise<boolean> {
  const skill = binding.skills.find(item => item.skillId === question.skillId);
  // Part grading also needs a pinned private snapshot, which the archive cannot supply.
  if (!skill || question.partSnapshot) return false;
  const [item] = await tx`SELECT v.id FROM opening_exam_attempt_links l
    JOIN opening_learning_attempts a ON a.id=l.learning_attempt_id AND a.workspace_id=${scope.workspaceId}
      AND a.owner_user_id=${scope.ownerUserId} AND a.course_id=${binding.courseId}
    JOIN opening_learning_sessions session ON session.id=a.session_id AND session.workspace_id=a.workspace_id
      AND session.owner_user_id=a.owner_user_id AND session.course_id=a.course_id AND session.skill_label=a.skill_label
      AND session.activity_id=a.activity_id AND session.source_ids @> a.source_ids
    JOIN opening_teaching_activities activity ON activity.id=a.activity_id AND activity.workspace_id=a.workspace_id
      AND activity.owner_user_id=a.owner_user_id AND activity.course_id=a.course_id AND activity.client_key=${activityKey}
    JOIN opening_learning_item_versions v ON v.id=a.item_version_id AND v.problem_id=a.problem_id
      AND v.workspace_id=a.workspace_id AND v.owner_user_id=a.owner_user_id AND v.course_id=a.course_id
    JOIN opening_problem_refs p ON p.problem_id=v.problem_id AND p.workspace_id=v.workspace_id
      AND p.source_id=v.source_id AND p.source_version=v.source_version AND p.stem_snapshot=v.stem_snapshot
      AND p.artifact_kind=v.artifact_kind
    JOIN opening_sources source ON source.id=v.source_id AND source.workspace_id=v.workspace_id AND source.version=v.source_version
    JOIN opening_source_versions sv ON sv.source_id=source.id AND sv.workspace_id=source.workspace_id AND sv.version=source.version
    WHERE l.sprint_id=${sprintId} AND l.exam_attempt_id=${attemptId}
      AND l.publication='pending_answer' AND l.observation_id IS NULL AND l.submitted_answer IS NULL AND l.captured_at IS NULL
      AND l.node_id=${skill.nodeId} AND l.requirement_key=${skill.requirementKey} AND a.requirement_key=l.requirement_key
      AND a.submitted_at IS NULL AND a.client_key='exam-attempt:' || l.id::text
      AND a.create_intent #>> '{examSprint,sprintId}'=${sprintId}
      AND a.create_intent #>> '{examSprint,examAttemptId}'=${attemptId}
      AND v.artifact_kind='reference_item' AND v.source_id=${binding.packSourceId} AND v.stem_snapshot=${question.prompt}
      AND a.source_ids=ARRAY[v.source_id] AND a.source_versions->v.source_id::text=to_jsonb(v.source_version)
      AND source.upload_state='uploaded' AND source.parse_state='ready' AND sv.availability='available'
      AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=source.workspace_id AND e.source_id=source.id)`;
  if (!item) return false;
  await tx`UPDATE opening_learning_item_versions SET evaluation_spec=${tx.json(buildExamChoiceSpec(pack, question))}
    WHERE id=${String(item.id)} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
  return true;
}

/** All raw specs have been cleared and the linked rows are now present in the restore transaction. */
export async function restorePendingSprintAttempts(tx: TransactionSql, scope: Scope): Promise<void> {
  const rows = await tx`SELECT s.id,s.state,b.course_id,b.binding FROM opening_exam_sprints s
    LEFT JOIN opening_exam_bindings b ON b.sprint_id=s.id
    WHERE s.course_id IS NULL AND s.workspace_id=${scope.workspaceId} AND s.owner_user_id=${scope.ownerUserId}
      AND (b.sprint_id IS NOT NULL OR EXISTS (SELECT 1 FROM opening_exam_attempt_links l WHERE l.sprint_id=s.id))`;
  for (const row of rows) {
    const { pack, state } = parseExamSprintSnapshot(EXAM_SPRINT_PACK, row.state);
    const run = state.runs.find(entry => entry.completedAt === null);
    if (!run || run.mode === "mock-a" || run.mode === "mock-b") continue;
    const attempts = state.attempts.filter(entry => entry.runId === run.id);
    const pending = attempts.at(-1);
    if (pending?.answeredAt) continue;
    const sprintId = String(row.id), activityKey = (id: string) => `exam-activity:${sprintId}:${id}`.slice(0, 200);
    const binding = row.binding == null ? null : parseExamBinding(row.binding);
    const question = pack.questions.find(entry => entry.id === pending?.questionId);
    if (pending && question && binding && binding.courseId === row.course_id
      && await restorePendingChoice(tx, scope, sprintId, pending.id, activityKey(pending.id), pack, question, binding)) continue;

    // Close the unusable run at its last recorded activity and keep the unanswered history.
    const timestamps = [...attempts.map(entry => entry.answeredAt ?? entry.presentedAt),
      ...(state.lessonExposures ?? []).filter(entry => entry.runId === run.id).map(entry => entry.openedAt)];
    run.completedAt = new Date(timestamps.reduce((last, at) => Math.max(last, Date.parse(at)), Date.parse(run.startedAt))).toISOString();
    await tx`UPDATE opening_exam_sprints SET state=${tx.json(state as never)} WHERE id=${sprintId}`;
    const keys = attempts.filter(entry => entry.answeredAt === null).map(entry => activityKey(entry.id));
    if (keys.length) await tx`UPDATE opening_teaching_activities SET status='completed',updated_at=clock_timestamp()
      WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
        AND status IN ('active','paused') AND client_key=ANY(${keys}::text[])`;
  }
}
