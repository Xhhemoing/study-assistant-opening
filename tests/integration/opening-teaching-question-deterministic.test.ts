import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { CourseRouteActionResult, CourseRouteRequirementInput, TeachingQuestionInteraction } from "@aistudy/contracts";
import { createOpeningLearningGoalRepository, createOpeningTeachingContentRepository, createOpeningTeachingHintRepository } from "@aistudy/database";
import { createOpeningCourseRouteRepository } from "../../packages/database/src/repositories/opening-course-route";
import { createOpeningAttemptService } from "../../apps/web/src/features/opening/learning/attempt-service";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";

let f: OpeningFixture;
beforeEach(async () => { f = await createOpeningFixture(); });
afterEach(async () => { await f?.close(); });

function ready(value: CourseRouteActionResult) {
  expect(value.kind).toBe("ready");
  if (value.kind !== "ready") throw new Error(JSON.stringify(value));
  return value;
}

type Question = { prompt: string; key: string; interaction: TeachingQuestionInteraction };
const numeric: Question = { prompt: "计算 1/3 + 1/4", key: "7/12", interaction: { kind: "numeric" } };
const choice: Question = { prompt: "计算 2/3 + 1/6", key: "B", interaction: { kind: "choice", options: [
  { id: "A", label: "1/2" }, { id: "B", label: "5/6" },
] } };

async function seed(questions: Question[] = [numeric, choice]) {
  const base = await learningAttemptFixture(f);
  await f.sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,visibility)
    VALUES(${f.scope.workspaceId},${base.courseId},'source',${base.sourceId},'core','course')`;
  const goal = await createOpeningLearningGoalRepository(f.sql).create(f.scope, {
    clientKey: randomUUID(), courseIds: [base.courseId], title: "分数运算", kind: "custom", targetDate: null,
    examDate: null, weeklyMinutes: 120, priority: 1, learningMode: "understand", successCriteria: "独立完成分数加法",
  });
  const requirement: CourseRouteRequirementInput = {
    id: randomUUID(), stableSkillId: randomUUID(), knowledgeNodeId: null, requirementKey: "fractions:addition",
    title: "分数加法", position: 0, mandatory: true, goalIds: [goal.id], prerequisiteIds: [],
    sourceRefs: [{ sourceId: base.sourceId, sourceVersion: 1, chunkId: base.chunkId }], origin: "confirmed",
    verification: { kind: "rubric", status: "needs_check", exerciseKeys: [], rubric: "精确计算分数加法并约分", missingReasons: [] },
  };
  const route = createOpeningCourseRouteRepository(f.sql, { compilerEnabled: true });
  await route.confirm(f.scope, base.courseId, { expectedRevisions: [], requirements: [requirement], confirmScope: true });
  // Ready is a server-side fixture fact, never trusted from a confirmation request.
  const verification = { ...requirement.verification, status: "ready", exerciseKeys: ["arithmetic-fixture"] };
  await f.sql`UPDATE course_requirements SET verification=${f.sql.json(verification)}
    WHERE id=${requirement.id} AND workspace_id=${f.scope.workspaceId} AND owner_user_id=${f.scope.ownerUserId}`;
  const started = ready(await route.start(f.scope, base.courseId, { goalId: goal.id, expectedGoalRevision: 1,
    requirementId: requirement.id, expectedRequirementRevision: 1, clientKey: randomUUID(), minutes: 20 }));
  const content = createOpeningTeachingContentRepository(f.sql);
  const blocks = questions.map(question => ({ ...question, blockId: randomUUID(), answerId: randomUUID() }));
  const unit = await content.createUnit(f.scope, { title: "分数加法练习", blocks: blocks.flatMap(question => [
    { id: question.blockId, type: "prompt", content: { text: question.prompt, interaction: question.interaction } },
    { id: question.answerId, type: "answer_key", content: { answer: question.key, hidden: true,
      hints: { direction: "先比较分母。", concept: "通分后相加。", firstStep: "找公分母。" } } },
  ]) });
  await content.publishActivitySpec(f.scope, { activityId: started.activity.id, teachingUnitId: unit.id,
    expectedVersion: 0, expectedRevisionNumber: 1, revisionNumber: 1,
    blockOrder: blocks.flatMap((question, index) => [
      { blockId: question.blockId, blockType: "prompt", role: "prompt", position: index * 2 },
      { blockId: question.answerId, blockType: "answer_key", role: "answer_key", position: index * 2 + 1 },
    ]), sourceRefs: [{ sourceId: base.sourceId, chunkId: base.chunkId, version: 1 }] });
  const session = await base.learning.createSession(f.scope, { activityId: started.activity.id, courseId: base.courseId,
    skillLabel: started.activity.learnerFocus!.skillLabel, sourceIds: [base.sourceId] });
  const service = createOpeningAttemptService(f.sql);
  const start = (index = 0) => service.create(f.scope, { sessionId: session.id, clientKey: randomUUID(),
    teachingBlock: { blockId: blocks[index]!.blockId, contentVersion: 1 } });
  const submit = async (index: number, answer: string) => {
    const attempt = await start(index);
    // Same free, metadata-only grading admission as learningAttemptFixture; no model is invoked.
    const observation = await base.learning.insertObservation(f.scope, { sessionId: session.id, activityId: started.activity.id,
      courseId: base.courseId, skillLabel: started.activity.learnerFocus!.skillLabel, sourceIds: [base.sourceId],
      attemptId: attempt.id, problemId: attempt.problemId, answer, outcome: "unverified", assistance: "independent", clientKey: randomUUID() },
    { autoGrade: { enabled: true, modelAvailable: true, dailyCap: 50,
      primaryModel: { modelSnapshot: { id: "fixture", providerId: "fixture", modelName: "fixture",
        inputCentsPerMillion: 0, outputCentsPerMillion: 0 }, inputCentsPerMillion: 0, outputCentsPerMillion: 0,
        billing: "free_tier", dailyRequestCap: 10000 },
      dayStart: new Date(Date.now() - 86400000), dayEnd: new Date(Date.now() + 86400000) } });
    return { attempt, observation };
  };
  return { ...base, route, goal, requirement, started, session, service, start, submit };
}

async function gradingJobs(observationId: string) {
  return f.sql`SELECT id FROM opening_jobs WHERE workspace_id=${f.scope.workspaceId}
    AND owner_user_id=${f.scope.ownerUserId} AND kind='grade-observation' AND payload->>'observationId'=${observationId}`;
}

it("verifies a ready requirement after two different first-seen arithmetic questions without AI grading", async () => {
  const x = await seed();
  const first = await x.submit(0, "7/12");
  expect(first.observation).toMatchObject({ outcome: "correct", verdictSource: "deterministic",
    serverEvaluation: { evaluatorVersion: "teaching-key-exact-v1", specVersion: "teaching-key-v1", decision: "correct" },
    eligibility: { verifiedCorrect: "yes", independentAttempt: "yes", usableForCurrentVersion: "yes" } });
  expect((await x.route.read(f.scope, x.courseId)).requirements[0]!.status).not.toBe("verified");
  const second = await x.submit(1, "B. 5/6");
  expect(second.attempt.problemId).not.toBe(first.attempt.problemId);
  expect(second.observation).toMatchObject({ outcome: "correct", verdictSource: "deterministic",
    serverEvaluation: { evaluatorVersion: "teaching-key-exact-v1", specVersion: "teaching-key-v1", decision: "correct" },
    eligibility: { verifiedCorrect: "yes", independentAttempt: "yes", usableForCurrentVersion: "yes" } });
  expect((await x.route.read(f.scope, x.courseId)).requirements[0]).toMatchObject({ status: "verified", requirement: { verification: { status: "ready" } } });
  expect(await gradingJobs(first.observation.id)).toHaveLength(0);
  expect(await gradingJobs(second.observation.id)).toHaveLength(0);
});

it("records a controlled incorrect answer and enters the existing route correction flow", async () => {
  const x = await seed(), result = await x.submit(0, "1/2");
  expect(result.observation).toMatchObject({ outcome: "incorrect", verdictSource: "deterministic",
    serverEvaluation: { evaluatorVersion: "teaching-key-exact-v1", specVersion: "teaching-key-v1", decision: "incorrect", outcome: "incorrect" },
    eligibility: { verifiedCorrect: "no" } });
  const snapshot = await x.route.read(f.scope, x.courseId, x.started.activity.id);
  expect(snapshot.requirements[0]!.status).toBe("needs_correction");
  const next = ready(await x.route.next(f.scope, x.courseId, { goalId: x.goal.id, expectedGoalRevision: 1,
    activityId: x.started.activity.id, expectedPathVersion: snapshot.currentActivity!.pathVersion,
    observationId: result.observation.id, clientKey: randomUUID(), minutes: 20 }));
  expect(next.action).toBe("targeted_explain");
  expect(await gradingJobs(result.observation.id)).toHaveLength(0);
});

it.each([
  { name: "unknown choice id", question: choice, answer: "C. 5/6" },
  { name: "numeric expression", question: numeric, answer: "1/3 + 1/4" },
  { name: "numeric answer with a unit", question: numeric, answer: "7/12 米" },
  { name: "numeric question with a unit", question: { ...numeric, interaction: { kind: "numeric", unit: "米" } } as Question, answer: "7/12" },
])("keeps $name unknown and queues ordinary AI feedback", async ({ question, answer }) => {
  const x = await seed([question]), result = await x.submit(0, answer);
  expect(result.observation.verdictSource).toBe("self_report");
  expect(result.observation.serverEvaluation).toBeNull();
  expect(result.observation.eligibility?.verifiedCorrect).not.toBe("yes");
  expect(result.observation.allowsIndependent).toBe(false);
  expect(await gradingJobs(result.observation.id)).toHaveLength(1);
  expect((await x.route.read(f.scope, x.courseId)).requirements[0]!.status).not.toBe("verified");
});

it("keeps a correct answer after a delivered hint from becoming independent evidence", async () => {
  const x = await seed(), attempt = await x.start();
  await createOpeningTeachingHintRepository(f.sql).read(f.scope, { attemptId: attempt.id, level: 1 });
  // The client still claims independence; the real submit service resolves the delivered hint.
  const observation = await x.service.submit(f.scope, attempt.id, { clientKey: randomUUID(), answer: "7/12",
    outcome: "unverified", assistance: "independent", verdictSource: "self_report" });
  expect(observation).toMatchObject({ verdictSource: "deterministic", outcome: "correct", assistance: "hinted",
    eligibility: { independentAttempt: "no" }, allowsIndependent: false });
  expect(observation.eligibility?.independentAttempt).not.toBe("yes");
  expect((await x.route.read(f.scope, x.courseId)).requirements[0]!.status).not.toBe("verified");
});

it("does not turn a second controlled answer to the same question into independent evidence", async () => {
  const x = await seed(), first = await x.submit(0, "7/12"), repeated = await x.submit(0, "7/12");
  expect(first.observation.eligibility?.verifiedCorrect).toBe("yes");
  expect(repeated.attempt.id).not.toBe(first.attempt.id);
  expect(repeated.attempt.problemId).toBe(first.attempt.problemId);
  expect(repeated.observation).toMatchObject({ verdictSource: "deterministic", outcome: "correct", assistance: "hinted",
    allowsIndependent: false });
  expect(repeated.observation.eligibility?.independentAttempt).not.toBe("yes");
  expect((await x.route.read(f.scope, x.courseId)).requirements[0]!.status).not.toBe("verified");
});
