import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { ExamPack, ExamSprintState } from "@aistudy/contracts";
import { evaluateEvidenceEligibility } from "@aistudy/domain";
import {
  readOpeningLearningEvidenceContext, createCourseMembershipRepository, createOpeningLearningGoalRepository, createOpeningLearningRepository,
  createOpeningTeachingContentRepository, createOpeningTeachingHintRepository,
} from "@aistudy/database";
import { createOpeningAttemptService } from "../../apps/web/src/features/opening/learning/attempt-service";
import { prepareSprintLesson } from "../../apps/web/src/features/opening/exam-sprint/lesson-navigation";
import { EXAM_LESSONS } from "../../packages/domain/src/opening/exam-sprint/lessons";
import { createOpeningExamIntegrationRepository } from "../../packages/database/src/repositories/opening-exam-integration";
import { createOpeningExamSprintRepository } from "../../packages/database/src/repositories/opening-exam-sprint";
import { readExamCourseEvidenceLinks } from "../../packages/database/src/repositories/opening-course-exam-evidence-projection";
import { createOpeningCourseRouteRepository } from "../../packages/database/src/repositories/opening-course-route";
import { readCourseRouteObservations } from "../../packages/database/src/repositories/opening-course-route-read";
import { readOpeningTeachingCompilerFocus } from "../../packages/database/src/repositories/opening-teaching-focus";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

let f: OpeningFixture;
beforeEach(async () => { f = await createOpeningFixture(); });
afterEach(async () => { await f?.close(); });
const key = () => `midterm-joint:${randomUUID()}`;

async function setup(siblingEvaluated: boolean) {
  const lesson = structuredClone(EXAM_LESSONS[0]!);
  const pack: ExamPack = {
    id: "midterm-joint-fixture", version: "1", title: "Midterm boundaries", description: "Fixture only",
    topics: [{ id: lesson.topicId, title: "Limits" }], lessons: [lesson],
    questions: ["mock-a-1", "mock-a-2", "training-sibling"].map((id, index) => ({
      id, topicId: lesson.topicId, skillId: index === 2 ? "sibling" : "target", lessonId: lesson.id,
      familyId: `joint-family-${index}`, pool: index === 2 ? "training" : "mock-a", difficulty: "foundation",
      prompt: `Joint question ${index}`, options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
      answer: "a", explanation: "Whole-question reference", hint: "Direction", estimatedMinutes: 5,
    })), sourceItems: [], weekPlan: [], limitations: ["No model effectiveness claim"],
  };
  const courses = createCourseMembershipRepository(f.sql);
  const course = await courses.createCourse({ workspaceId: f.scope.workspaceId, title: "Joint exam", slug: randomUUID() });
  const other = await courses.createCourse({ workspaceId: f.scope.workspaceId, title: "Unrelated", slug: randomUUID() });
  const integration = createOpeningExamIntegrationRepository(f.sql, pack);
  const bound = await integration.bind(f.scope, { clientKey: key(), courseId: course.id, milestoneId: null,
    expectedPackVersion: pack.version, createKnowledgeNodes: true, skills: [], materials: [] });
  const route = createOpeningCourseRouteRepository(f.sql, { compilerEnabled: true, exactVerificationEnabled: true });
  const confirmed = await route.confirm(f.scope, course.id, { expectedRevisions: [],
    requirements: (await route.read(f.scope, course.id)).suggestions, confirmScope: true });
  const requirement = (skillId: string) => confirmed.requirements.find(row => row.requirement.knowledgeNodeId
    === bound.binding!.skills.find(skill => skill.skillId === skillId)!.nodeId)!.requirement;
  const target = requirement("target"), sibling = requirement("sibling");
  const goal = await createOpeningLearningGoalRepository(f.sql).create(f.scope, { clientKey: key(), courseIds: [course.id],
    title: "Correct the left part", kind: "custom", targetDate: null, examDate: null, weeklyMinutes: 120,
    priority: 1, learningMode: "understand", successCriteria: "Independently explain the failed part" });
  // Trusted frozen server revision fixture, as in opening-course-exam-evidence.
  // Only identity/evaluator inputs are seeded; all results are produced by repo.act.
  const [stored] = await f.sql`SELECT id,pack_snapshot FROM opening_exam_sprints
    WHERE workspace_id=${f.scope.workspaceId} AND owner_user_id=${f.scope.ownerUserId} AND course_id IS NULL`;
  const frozen = stored!.pack_snapshot as ExamPack;
  frozen.questions.find(q => q.id === "mock-a-1")!.partSnapshot = {
    packId: frozen.id, packVersion: frozen.version, questionId: "mock-a-1", familyId: "joint-family-0",
    questionIdentityRefId: randomUUID(), parts: [
      { partId: "left", identityRefId: randomUUID(), requirementKey: target.requirementKey,
        evaluator: { kind: "choice-options-v1", correctOptionIds: ["b"] } },
      { partId: "right", identityRefId: randomUUID(), requirementKey: sibling.requirementKey,
        ...(siblingEvaluated ? { evaluator: { kind: "choice-options-v1" as const, correctOptionIds: ["a"] } } : {}) },
    ],
  };
  await f.sql`UPDATE opening_exam_sprints SET pack_snapshot=${f.sql.json(frozen as never)} WHERE id=${stored!.id}`;
  return { courseId: course.id, otherCourseId: other.id, target, sibling, goal, route, pack,
    sprint: createOpeningExamSprintRepository(f.sql, pack), sprintId: String(stored!.id) };
}

it.each([true, false])("joins sealed mock parts, explicit teaching and unknown qualification without regrading (sibling evaluated=%s)", async siblingEvaluated => {
  const x = await setup(siblingEvaluated);
  const first = await x.sprint.act(f.scope, { action: "start", mode: "mock-a", clientKey: key() });
  expect(first.currentAttempt!.questionId).toBe("mock-a-1");
  const firstId = first.currentAttempt!.id;
  const answered = await x.sprint.act(f.scope, { action: "answer", attemptId: firstId, answer: "a", confidence: 4, clientKey: key() });
  expect(answered.attempts[0]).toMatchObject({ answer: "a", correct: null, independent: false, feedback: null });
  expect(await readExamCourseEvidenceLinks(f.sql, f.scope, x.courseId)).toEqual([]);
  expect((await x.route.read(f.scope, x.courseId)).requirements.every(row => row.status === "unobserved")).toBe(true);
  const view = await x.sprint.act(f.scope, { action: "next", runId: first.activeRun!.id, clientKey: key() });
  expect(view.currentAttempt!.questionId).toBe("mock-a-2");
  expect(prepareSprintLesson(view, view.currentAttempt!.question.lessonId)).toBeNull(); // No implicit consent.
  await expect(x.sprint.act(f.scope, { action: "help", attemptId: view.currentAttempt!.id, kind: "solution", clientKey: key() }))
    .rejects.toMatchObject({ code: "CONFLICT" });
  const intent = prepareSprintLesson(view, view.currentAttempt!.question.lessonId, true);
  if (!intent || intent.action !== "switch_to_teaching") throw new Error("Expected explicit conversion intent");
  const command = { ...intent, clientKey: key() };
  const converted = await x.sprint.act(f.scope, command);
  expect(converted.activeRun).toBeNull();
  const run = converted.state.runs[0]!;
  expect(run).toMatchObject({ ...view.activeRun, mode: "mock-a", completedAt: expect.any(String),
    conversion: { attemptId: view.currentAttempt!.id, convertedAt: run.completedAt } });
  expect(run.deadlineAt).toBe(first.activeRun!.deadlineAt);
  expect(converted.attempts[0]).toMatchObject({ id: firstId, answer: "a", answeredAt: answered.attempts[0]!.answeredAt,
    durationSeconds: answered.attempts[0]!.durationSeconds, correct: true, independent: true, help: [] });
  expect(converted.attempts[1]).toMatchObject({ id: view.currentAttempt!.id, answer: null, correct: null,
    independent: false, help: [{ kind: "solution", at: run.completedAt }] });
  expect((await x.sprint.act(f.scope, command)).state).toEqual(converted.state);
  await expect(x.sprint.act(f.scope, { action: "answer", attemptId: view.currentAttempt!.id, answer: "a", confidence: 4, clientKey: key() }))
    .rejects.toMatchObject({ code: "CONFLICT" });

  const links = await readExamCourseEvidenceLinks(f.sql, f.scope, x.courseId);
  expect(links).toHaveLength(1);
  const link = links[0]!;
  expect(link.parts!.map(part => [part.partId, part.outcome, part.assistance])).toEqual([
    ["left", "incorrect", "independent"], ["right", siblingEvaluated ? "correct" : "unknown", siblingEvaluated ? "independent" : "unknown"],
  ]);
  const evidence = await readCourseRouteObservations(f.sql, f.scope, x.courseId, false);
  expect(evidence.raw).toHaveLength(1);
  const original = evidence.raw[0]!;
  expect(original).toMatchObject({ id: link.observationId, outcome: "correct", assistance: "independent",
    verdictSource: "deterministic", serverEvaluation: { evaluatorVersion: "exam-choice-exact-v1", decision: "correct" } });
  const facts = await readOpeningLearningEvidenceContext(f.sql, f.scope, original);
  expect(evaluateEvidenceEligibility(facts.observation, facts.context)).toMatchObject({
    independentAttempt: "yes", verifiedCorrect: "yes", usableForDelayedCheck: "unknown",
  });
  expect(evidence.projected.find(row => row.requirementKey === x.target.requirementKey))
    .toMatchObject({ verifiedCorrect: "no", independentAttempt: "yes", examPartFocus: { partId: "left" } });
  expect(evidence.projected.find(row => row.requirementKey === x.sibling.requirementKey))
    .toMatchObject({ verifiedCorrect: siblingEvaluated ? "yes" : "unknown", independentAttempt: siblingEvaluated ? "yes" : "no" });
  const progress = await x.route.read(f.scope, x.courseId);
  expect(progress.requirements.find(row => row.requirement.id === x.target.id)!.status).toBe("needs_correction");
  expect(progress.requirements.find(row => row.requirement.id === x.sibling.id)!.status).toBe("needs_verification");
  expect(progress.summary.verified).toBe(0); // One correct sibling / unknown is not mastery.
  expect(progress.requirements.every(row => row.delayedCheck?.status === "not_scheduled")).toBe(true);
  expect(await f.sql`SELECT dimension FROM opening_skill_evidence WHERE observation_id=${original.id}`).toEqual([{ dimension: "timed" }]);
  const receipts = await f.sql`SELECT l.exam_attempt_id,h.kind FROM opening_exam_help_receipts h
    JOIN opening_exam_attempt_links l ON l.id=h.attempt_link_id WHERE l.sprint_id=${x.sprintId}`;
  expect(receipts).toEqual([{ exam_attempt_id: view.currentAttempt!.id, kind: "solution" }]);

  const started = await x.route.start(f.scope, x.courseId, { goalId: x.goal.id, expectedGoalRevision: x.goal.revision,
    requirementId: x.target.id, expectedRequirementRevision: x.target.revision, clientKey: key(), minutes: 20 });
  if (started.kind !== "ready") throw new Error(JSON.stringify(started));
  const focus = { questionIdentityRefId: link.questionIdentityRefId, partId: "left",
    identityRefId: link.parts!.find(part => part.partId === "left")!.identityRefId, requirementKey: x.target.requirementKey };
  expect(started.activity.learnerFocus).toMatchObject({ activityKind: "targeted_explain", focusObservationId: original.id, examPartFocus: focus });
  expect(await readOpeningTeachingCompilerFocus(f.sql, f.scope, started.activity.id)).toMatchObject({
    learnerFocus: { examPartFocus: focus }, focusAttempt: { question: "Joint question 0", answer: "a" },
  });
  // Publish a saved teaching fixture through the real content API, not a model result.
  // This explanatory answer is deliberately outside exact-choice/arithmetic authority.
  const content = createOpeningTeachingContentRepository(f.sql), promptId = randomUUID(), answerId = randomUUID();
  const unit = await content.createUnit(f.scope, { title: "Left-part correction", blocks: [
    { id: promptId, type: "prompt", content: { text: "Explain why the limit law requires its stated hypotheses." } },
    { id: answerId, type: "answer_key", content: { hidden: true, answer: "Check that each hypothesis holds.",
      hints: { direction: "Inspect the hypotheses.", concept: "A law has conditions.", firstStep: "List each condition." } } },
  ] });
  await content.publishActivitySpec(f.scope, { activityId: started.activity.id, teachingUnitId: unit.id, expectedVersion: 0,
    expectedRevisionNumber: 1, revisionNumber: 1, blockOrder: [
      { blockId: promptId, position: 0, role: "prompt", blockType: "prompt" },
      { blockId: answerId, position: 1, role: "answer_key", blockType: "answer_key" },
    ], sourceRefs: started.activity.sourceIds.map(sourceId => ({ sourceId,
      chunkId: x.target.sourceRefs.find(ref => ref.sourceId === sourceId)!.chunkId!,
      version: x.target.sourceRefs.find(ref => ref.sourceId === sourceId)!.sourceVersion })) });
  const session = await createOpeningLearningRepository(f.sql).createSession(f.scope, { activityId: started.activity.id,
    courseId: x.courseId, skillLabel: x.target.title, sourceIds: started.activity.sourceIds });
  const attempts = createOpeningAttemptService(f.sql);
  const attempt = await attempts.create(f.scope, { sessionId: session.id, clientKey: key(), teachingBlock: { blockId: promptId, contentVersion: 1 } });
  expect(attempt.courseRequirement).toMatchObject({ id: x.target.id, requirementKey: x.target.requirementKey });
  await createOpeningTeachingHintRepository(f.sql).read(f.scope, { attemptId: attempt.id, level: 1 });
  const reported = await attempts.submit(f.scope, attempt.id, { clientKey: key(), answer: "All hypotheses hold.",
    outcome: "correct", assistance: "independent", verdictSource: "self_report" });
  expect(reported).toMatchObject({ verdictSource: "self_report", eligibility: {
    independentAttempt: "no", verifiedCorrect: "unknown", usableForDelayedCheck: "no",
  } });
  expect(reported.serverEvaluation ?? null).toBeNull();
  expect((await x.route.read(f.scope, x.courseId)).summary.verified).toBe(0);
  expect(await readExamCourseEvidenceLinks(f.sql, f.scope, x.courseId)).toEqual(links);
  const after = await readCourseRouteObservations(f.sql, f.scope, x.courseId, false);
  expect(after.raw.find(row => row.id === original.id)).toEqual(original);
  const [saved] = await f.sql`SELECT state FROM opening_exam_sprints WHERE id=${x.sprintId}`;
  const state = saved!.state as ExamSprintState;
  expect(state.attempts.find(row => row.id === firstId)).toMatchObject({ answer: "a", correct: true, help: [],
    resultMetadata: { questionEvaluation: { parts: link.parts!.map(({ partId, outcome, assistance }) => expect.objectContaining({ partId, outcome, assistance })) } } });
  expect((await x.sprint.read(f.scope)).attempts).toEqual(converted.attempts);

  expect((await x.route.read(f.scope, x.otherCourseId)).summary).toMatchObject({ total: 0, verified: 0 });
  for (const scope of [f.otherScope, { ...f.scope, ownerUserId: f.otherScope.ownerUserId }, { ...f.scope, workspaceId: f.otherScope.workspaceId }]) {
    expect(await readExamCourseEvidenceLinks(f.sql, scope, x.courseId)).toEqual([]);
    await expect(x.route.read(scope, x.courseId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  }
  expect(await readExamCourseEvidenceLinks(f.sql, f.scope, x.otherCourseId)).toEqual([]);
  expect((await readCourseRouteObservations(f.sql, f.scope, x.otherCourseId)).raw).toEqual([]);
});
