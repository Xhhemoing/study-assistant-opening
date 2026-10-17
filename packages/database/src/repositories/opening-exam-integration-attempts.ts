import { randomUUID } from "node:crypto";
import type { TransactionSql } from "postgres";
import type { ExamAttempt, ExamCourseBinding, ExamPack, ExamSprintCommand, ExamSprintState, Scope } from "@aistudy/contracts";
import { examSprintOverview } from "@aistudy/domain";
import { admitLearningSources, learningError, nextLearningHistoryRevision, nextWorkspaceLearningHistoryRevision } from "./opening-learning-facts";
import { createExamSession } from "./opening-exam-integration-session";
import { insertOpeningLearningObservationInTx } from "./opening-learning-observations";
import { invalidateOpeningLearningEligibility } from "./opening-learning-eligibility";
import { examSkillLabel, readExamBinding, readExamEvidenceState } from "./opening-exam-integration-facts";
import { projectExamSourceRecord } from "./opening-exam-integration-sources";


async function present(tx: TransactionSql, scope: Scope, sprintId: string, pack: ExamPack, binding: ExamCourseBinding,
  before: ExamSprintState, state: ExamSprintState, attempt: ExamAttempt, now: string) {
  const question = pack.questions.find(item => item.id === attempt.questionId)!;
  const skill = binding.skills.find(item => item.skillId === question.skillId);
  if (!skill) throw learningError("CONFLICT", "冲刺技能尚未绑定正式知识节点");
  const sourceIds = [binding.packSourceId], sources = await admitLearningSources(tx, scope, sourceIds);
  const sourceVersion = Number(sources[0]!.version), sourceVersions = { [binding.packSourceId]: sourceVersion };
  const skillLabel = examSkillLabel(pack, question.skillId);
  const { sessionId, activityId } = await createExamSession(tx, scope, { sprintId, courseId: binding.courseId,
    sourceIds, skillLabel, identity: attempt.id, now });
  const spec = { kind: "exam_choice", specVersion: "exam-choice-v1", packId: pack.id, packVersion: pack.version,
    questionId: question.id, familyId: question.familyId };
  const [existing] = await tx`SELECT v.id,v.problem_id FROM opening_learning_item_versions v
    WHERE v.workspace_id=${scope.workspaceId} AND v.owner_user_id=${scope.ownerUserId} AND v.course_id=${binding.courseId}
      AND v.source_id=${binding.packSourceId} AND v.source_version=${sourceVersion} AND v.evaluation_spec=${tx.json(spec)} ORDER BY created_at,id LIMIT 1`;
  const problemId = existing ? String(existing.problem_id) : randomUUID(), itemVersionId = existing ? String(existing.id) : randomUUID();
  if (!existing) {
    await tx`INSERT INTO opening_problem_refs(problem_id,workspace_id,session_id,source_id,source_version,stem_snapshot,artifact_kind)
      VALUES(${problemId},${scope.workspaceId},${sessionId},${binding.packSourceId},${sourceVersion},${question.prompt},'reference_item')`;
    await tx`INSERT INTO opening_learning_item_versions(id,workspace_id,owner_user_id,course_id,activity_id,problem_id,source_id,source_version,stem_snapshot,artifact_kind,evaluation_spec,created_at)
      VALUES(${itemVersionId},${scope.workspaceId},${scope.ownerUserId},${binding.courseId},${activityId},${problemId},${binding.packSourceId},${sourceVersion},${question.prompt},'reference_item',${tx.json(spec)},${now})`;
  }
  const revision = await nextLearningHistoryRevision(tx, scope, binding.courseId);
  await nextWorkspaceLearningHistoryRevision(tx, scope);
  const learningAttemptId = randomUUID(), linkId = randomUUID();
  await tx`INSERT INTO opening_learning_attempts(id,workspace_id,owner_user_id,session_id,course_id,activity_id,skill_label,requirement_key,
    problem_id,item_version_id,source_ids,source_versions,client_key,create_intent,history_revision,started_at)
    VALUES(${learningAttemptId},${scope.workspaceId},${scope.ownerUserId},${sessionId},${binding.courseId},${activityId},${skillLabel},${skill.requirementKey},
      ${problemId},${itemVersionId},${sourceIds},${tx.json(sourceVersions)},${`exam-attempt:${linkId}`},
      ${tx.json({ examSprint: { sprintId, examAttemptId: attempt.id, spec }, nodeId: skill.nodeId })},${revision},${attempt.presentedAt})`;
  const index = state.attempts.findIndex(item => item.id === attempt.id);
  const firstFamily = !state.attempts.slice(0, index).some(item => pack.questions.find(q => q.id === item.questionId)?.familyId === question.familyId);
  const run = state.runs.find(item => item.id === attempt.runId)!;
  const delayedEarliest = run.mode === "retest" ? examSprintOverview(before, pack, now,
    await readExamEvidenceState(tx, scope, sprintId, before)).skills.find(item => item.skillId === question.skillId)?.dueAt ?? null : null;
  await tx`INSERT INTO opening_exam_attempt_links(id,sprint_id,exam_attempt_id,learning_attempt_id,node_id,requirement_key,
    first_family_exposure,delayed_earliest_at,publication,prediction)
    VALUES(${linkId},${sprintId},${attempt.id},${learningAttemptId},${skill.nodeId},${skill.requirementKey},${firstFamily},${delayedEarliest},
      'pending_answer',${attempt.prediction ? tx.json(attempt.prediction as never) : null})`;
}

async function help(tx: TransactionSql, scope: Scope, sprintId: string, pack: ExamPack, binding: ExamCourseBinding,
  attempt: ExamAttempt) {
  const [link] = await tx`SELECT * FROM opening_exam_attempt_links WHERE sprint_id=${sprintId} AND exam_attempt_id=${attempt.id}`;
  if (!link) return; // Pre-binding history remains isolated and never receives invented canonical facts.
  const question = pack.questions.find(item => item.id === attempt.questionId)!;
  for (const exposure of attempt.help) {
    const [existing] = await tx`SELECT id FROM opening_exam_help_receipts WHERE attempt_link_id=${String(link.id)} AND kind=${exposure.kind}`;
    if (existing) continue;
    const revision = await nextLearningHistoryRevision(tx, scope, binding.courseId);
    const workspaceRevision = await nextWorkspaceLearningHistoryRevision(tx, scope);
    const content = exposure.kind === "hint" ? question.hint : exposure.kind === "solution"
      ? `${question.answer}\n${question.explanation}` : "用户主动登记已使用外部帮助";
    await tx`INSERT INTO opening_exam_help_receipts(id,attempt_link_id,kind,delivered_at,history_revision,workspace_history_revision,content_snapshot)
      VALUES(${randomUUID()},${String(link.id)},${exposure.kind},${exposure.at},${revision},${workspaceRevision},${content})`;
  }
  await invalidateOpeningLearningEligibility(tx, scope, { sourceIds: [binding.packSourceId] });
}

async function publish(tx: TransactionSql, scope: Scope, sprintId: string, state: ExamSprintState, attempt: ExamAttempt) {
  const [row] = await tx`SELECT l.id AS link_id,l.publication,l.node_id,l.first_family_exposure,a.*
    FROM opening_exam_attempt_links l JOIN opening_learning_attempts a ON a.id=l.learning_attempt_id
    WHERE l.sprint_id=${sprintId} AND l.exam_attempt_id=${attempt.id} AND a.workspace_id=${scope.workspaceId}
      AND a.owner_user_id=${scope.ownerUserId} FOR UPDATE OF a,l`;
  if (!row || row.publication === "published" || attempt.answer === null || attempt.answeredAt === null) return;
  const run = state.runs.find(item => item.id === attempt.runId)!;
  const sealed = (run.mode === "mock-a" || run.mode === "mock-b") && run.completedAt === null;
  await tx`UPDATE opening_exam_attempt_links SET submitted_answer=${attempt.answer},captured_at=${attempt.answeredAt},
    publication=${sealed ? "pending_mock" : "pending_answer"} WHERE id=${String(row.link_id)}`;
  if (sealed) return;
  const assistance = attempt.help.some(item => item.kind === "solution") ? "revealed"
    : attempt.help.length ? "hinted" : row.first_family_exposure === true ? "independent" : "unknown";
  const observation = await insertOpeningLearningObservationInTx(tx, scope, {
    sessionId: String(row.session_id), courseId: String(row.course_id), skillLabel: String(row.skill_label), sourceIds: row.source_ids as string[],
    attemptId: String(row.id), problemId: String(row.problem_id), answer: attempt.answer,
    outcome: "unverified", assistance, clientKey: `exam-publication:${String(row.link_id)}`, nodeId: String(row.node_id),
    dimension: run.mode === "mock-a" || run.mode === "mock-b" ? "timed" : "procedure",
  }, { examSprintPublication: true });
  await tx`UPDATE opening_exam_attempt_links SET observation_id=${observation.id},publication='published' WHERE id=${String(row.link_id)}`;
  await tx`UPDATE opening_teaching_activities SET status='completed',updated_at=clock_timestamp()
    WHERE id=${String(row.activity_id)} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
}

/** Called after the state write, in the same history/owner/course/sprint transaction. */
export async function syncExamIntegration(tx: TransactionSql, scope: Scope, sprintId: string, pack: ExamPack,
  before: ExamSprintState, state: ExamSprintState, command: ExamSprintCommand, now: string): Promise<void> {
  const binding = await readExamBinding(tx, sprintId);
  if (command.action === "source") {
    const record = state.sourceRecords.at(-1)!;
    await projectExamSourceRecord(tx, scope, sprintId, pack, binding, record, now);
  }
  if (!binding) return;
  const previousAttemptIds = new Set(before.attempts.map(attempt => attempt.id));
  for (const attempt of state.attempts.filter(item => !previousAttemptIds.has(item.id))) {
    await present(tx, scope, sprintId, pack, binding, before, state, attempt, now);
  }
  if (command.action === "help") await help(tx, scope, sprintId, pack, binding, state.attempts.find(item => item.id === command.attemptId)!);
  const previouslyAnswered = new Set(before.attempts.filter(attempt => attempt.answeredAt !== null).map(attempt => attempt.id));
  const previouslyOpenRuns = new Set(before.runs.filter(run => run.completedAt === null).map(run => run.id));
  const completedRuns = new Set(state.runs.filter(run => run.completedAt !== null && previouslyOpenRuns.has(run.id)).map(run => run.id));
  const candidates = state.attempts.filter(attempt => attempt.answeredAt !== null
    && (!previouslyAnswered.has(attempt.id) || completedRuns.has(attempt.runId)));
  if (!candidates.length) return;
  const pending = await tx`SELECT exam_attempt_id FROM opening_exam_attempt_links
    WHERE sprint_id=${sprintId} AND publication<>'published'`;
  const pendingIds = new Set(pending.map(link => String(link.exam_attempt_id)));
  for (const attempt of candidates.filter(item => pendingIds.has(item.id))) {
    await publish(tx, scope, sprintId, state, attempt);
  }
}
