import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ExamPack, ExamSprintOverview } from "@aistudy/contracts";
import { createOpeningBudgetRepository, createOpeningLearningAttemptRepository, createOpeningLearningGoalRepository, createOpeningLearningRepository, createOpeningPrivacyRepository, createOpeningSourceChunksRepository } from "@aistudy/database";
import { createCompileTeachingUnitWorkerDeps } from "../../apps/worker/src/runtime/compile-teaching-unit-wiring";
import { readOpeningTeachingCompilerFocus } from "../../packages/database/src/repositories/opening-teaching-focus";
import * as materialRetrieval from "../../apps/worker/src/runtime/material-retrieval";
import { createOpeningExamIntegrationRepository } from "../../packages/database/src/repositories/opening-exam-integration";
import { createOpeningExamSprintRepository } from "../../packages/database/src/repositories/opening-exam-sprint";
import { createOpeningCourseRouteRepository } from "../../packages/database/src/repositories/opening-course-route";
import { readCourseRouteObservations } from "../../packages/database/src/repositories/opening-course-route-read";
import { readExamCourseEvidenceLinks } from "../../packages/database/src/repositories/opening-course-exam-evidence-projection";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

const pack: ExamPack = {
  id: "route-exam-fixture", version: "1", title: "Route exam", description: "Fixture",
  topics: ["other", "one", "two"].map(id => ({ id, title: id })),
  lessons: ["other", "one", "two"].map(id => ({ id, topicId: id, title: id, summary: "summary", steps: ["step"], workedExample: "example", pitfalls: ["pitfall"] })),
  questions: ["other", "one", "two"].map(id => ({ id, topicId: id, skillId: id === "other" ? "other-skill" : "target-skill", familyId: `family-${id}`, lessonId: id, pool: "training", difficulty: "foundation", prompt: `Question ${id}`, options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], answer: "a", explanation: "answer", hint: "hint", estimatedMinutes: 1 })),
  sourceItems: [], weekPlan: [], limitations: ["Fixture"],
};
let f: OpeningFixture;
beforeEach(async () => { f = await createOpeningFixture(); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await f?.close(); });
const key = () => `route-exam:${randomUUID()}`;
async function setup() {
  const courseId = randomUUID();
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${courseId},${f.scope.workspaceId},'Exam route',${courseId})`;
  const integration = createOpeningExamIntegrationRepository(f.sql, pack);
  const sprint = createOpeningExamSprintRepository(f.sql, pack);
  const bound = await integration.bind(f.scope, { clientKey: key(), courseId, milestoneId: null, expectedPackVersion: pack.version, createKnowledgeNodes: true, skills: [], materials: [] });
  const targetNode = bound.binding!.skills.find(skill => skill.skillId === "target-skill")!.nodeId;
  const route = createOpeningCourseRouteRepository(f.sql, { compilerEnabled: true, exactVerificationEnabled: true });
  const suggestions = (await route.read(f.scope, courseId)).suggestions;
  const target = suggestions.find(row => row.knowledgeNodeId === targetNode)!;
  expect(target.requirementKey).toBe(`knowledge:${targetNode}`);
  const confirm = async () => {
    await route.confirm(f.scope, courseId, { expectedRevisions: [], requirements: suggestions, confirmScope: true });
    // The repository clock is truncated to milliseconds; separate confirmation from subsequent captures.
    await f.sql`SELECT pg_sleep(0.01)`;
  };
  const start = () => sprint.act(f.scope, { action: "start", mode: "diagnostic", clientKey: key() });
  const answer = (view: ExamSprintOverview, answerValue = "a") => sprint.act(f.scope, { action: "answer", attemptId: view.currentAttempt!.id, answer: answerValue, confidence: 4, clientKey: key() });
  const next = (view: ExamSprintOverview) => sprint.act(f.scope, { action: "next", runId: view.activeRun!.id, clientKey: key() });
  const progress = async () => (await route.read(f.scope, courseId)).requirements.find(row => row.requirement.id === target.id)!;
  const all = async () => { let view = await start(); for (let i = 0; i < 3; i++) { await answer(view); if (i < 2) view = await next(view); } };
  return { courseId, route, target, confirm, start, answer, next, all, progress };
}

async function setupParts(missing = false) {
  const x = await setup(); await x.confirm();
  const requirements = (await x.route.read(f.scope, x.courseId)).requirements.map(row => row.requirement);
  const other = requirements.find(row => row.id !== x.target.id)!;
  const [stored] = await f.sql`SELECT id,pack_snapshot FROM opening_exam_sprints WHERE workspace_id=${f.scope.workspaceId} AND owner_user_id=${f.scope.ownerUserId}`;
  const frozen = stored!.pack_snapshot as ExamPack;
  for (const q of frozen.questions.filter(q => q.skillId === "target-skill")) {
    // Trusted server revision fixture, not browser bindings or a fabricated grader outcome.
    q.partSnapshot = { packId: frozen.id, packVersion: frozen.version, questionId: q.id, familyId: q.familyId,
      questionIdentityRefId: randomUUID(), parts: [
        { partId: "left", identityRefId: randomUUID(), requirementKey: x.target.requirementKey,
          evaluator: { kind: "choice-options-v1", correctOptionIds: ["b"] } },
        { partId: "right", identityRefId: randomUUID(), requirementKey: other.requirementKey,
          ...(!missing ? { evaluator: { kind: "choice-options-v1" as const, correctOptionIds: ["a"] } } : {}) },
      ] };
  }
  await f.sql`UPDATE opening_exam_sprints SET pack_snapshot=${f.sql.json(frozen as never)} WHERE id=${stored!.id}`;
  const first = await x.start();
  const view = await x.next(await x.answer(first));
  return { ...x, other, view, frozen, sprintId: String(stored!.id) };
}

it("persists two-part trusted evaluation, projects one wrong/one correct, and replays without changing whole score", async () => {
  const x = await setupParts();
  const answerKey = key();
  const repo = createOpeningExamSprintRepository(f.sql, pack);
  const command = { action: "answer" as const, attemptId: x.view.currentAttempt!.id, answer: "a", confidence: 4, clientKey: answerKey };
  const view = await repo.act(f.scope, command);
  expect(view.currentAttempt!.correct).toBe(true); // Original whole-question score, NOT the left part.
  expect(JSON.stringify(view)).not.toMatch(/partSnapshot|resultMetadata|correctOptionIds/);
  const [stored] = await f.sql`SELECT state FROM opening_exam_sprints WHERE id=${x.sprintId}`;
  const state = stored!.state as import("@aistudy/contracts").ExamSprintState;
  const result = state.attempts.find(a => a.id === command.attemptId)!.resultMetadata!.questionEvaluation;
  expect(result.parts.map(p => [p.partId, p.outcome])).toEqual([["left", "incorrect"], ["right", "correct"]]);
  const evidence = await readCourseRouteObservations(f.sql, f.scope, x.courseId, false);
  const projected = evidence.projected.filter(o => o.id === result.evaluationRefId);
  expect(projected).toHaveLength(2);
  expect(projected.map(o => [o.requirementKey, o.verifiedCorrect])).toEqual([[x.target.requirementKey, "no"], [x.other.requirementKey, "yes"]]);
  expect(evidence.raw.find(o => o.id === result.evaluationRefId)?.outcome).toBe("correct");
  expect((await x.progress()).status).toBe("needs_correction");
  await repo.act(f.scope, command);
  const [replay] = await f.sql`SELECT state FROM opening_exam_sprints WHERE id=${x.sprintId}`;
  expect(replay!.state).toEqual(stored!.state);
  const reversed = structuredClone(x.frozen);
  reversed.questions.forEach(q => q.partSnapshot?.parts.reverse());
  await f.sql`UPDATE opening_exam_sprints SET pack_snapshot=${f.sql.json(reversed as never)} WHERE id=${x.sprintId}`;
  const links = await readExamCourseEvidenceLinks(f.sql, f.scope, x.courseId);
  // Ref order is not identity: persisted results stay usable after deterministic order changes.
  expect(links.find(l => l.observationId === result.evaluationRefId)?.parts).toHaveLength(2);
});

it("keeps revealed correct part assisted rather than copying sibling failure", async () => {
  const x = await setupParts();
  await createOpeningExamSprintRepository(f.sql, pack).act(f.scope, { action: "help", attemptId: x.view.currentAttempt!.id, kind: "solution", clientKey: key() });
  await x.answer(x.view);
  const evidence = await readCourseRouteObservations(f.sql, f.scope, x.courseId, false);
  const link = (await readExamCourseEvidenceLinks(f.sql, f.scope, x.courseId)).find(l => l.parts !== undefined)!;
  expect(evidence.projected.find(o => o.id === link.observationId && o.requirementKey === x.other.requirementKey))
    .toMatchObject({ verifiedCorrect: "yes", assistance: "revealed", independentAttempt: "no" });
});

it("leaves a missing part unknown and preserves revealed correctness without independent credit", async () => {
  const x = await setupParts(true);
  const repo = createOpeningExamSprintRepository(f.sql, pack);
  await repo.act(f.scope, { action: "help", attemptId: x.view.currentAttempt!.id, kind: "solution", clientKey: key() });
  await x.answer(x.view);
  const evidence = await readCourseRouteObservations(f.sql, f.scope, x.courseId, false);
  const links = await readExamCourseEvidenceLinks(f.sql, f.scope, x.courseId);
  const link = links.find(l => l.parts !== undefined)!;
  const projected = evidence.projected.filter(o => o.id === link.observationId);
  expect(projected.find(o => o.requirementKey === x.other.requirementKey)).toMatchObject({ verifiedCorrect: "unknown", assistance: "unknown", independentAttempt: "no" });
  expect(projected.find(o => o.requirementKey === x.target.requirementKey)).toMatchObject({ verifiedCorrect: "no", assistance: "revealed", independentAttempt: "no" });
});

it.each(["key", "version", "retract", "binding", "source", "identity"])("does not project current part credit after %s changes", async change => {
  const x = await setupParts(); await x.answer(x.view);
  const link = (await readExamCourseEvidenceLinks(f.sql, f.scope, x.courseId)).find(l => l.parts !== undefined)!;
  if (change === "identity") {
    const altered = structuredClone(x.frozen);
    altered.questions.filter(q => q.partSnapshot).forEach(q => { q.partSnapshot!.parts[0]!.identityRefId = randomUUID(); });
    await f.sql`UPDATE opening_exam_sprints SET pack_snapshot=${f.sql.json(altered as never)} WHERE id=${x.sprintId}`;
    await expect(readCourseRouteObservations(f.sql, f.scope, x.courseId, false)).rejects.toMatchObject({ code: "CONFLICT" });
    return;
  }
  if (change === "key") await f.sql`UPDATE course_requirements SET requirement_key='changed-key' WHERE id=${x.target.id}`;
  if (change === "version") await f.sql`UPDATE course_requirements SET revision=revision+1 WHERE id=${x.target.id}`;
  if (change === "retract") {
    const { reviseOpeningLearningObservation } = await import("../../packages/database/src/repositories/opening-observation-revisions");
    await reviseOpeningLearningObservation(f.sql, f.scope, { revisionKind: "retract", rootObservationId: link.observationId,
      revisesObservationId: link.observationId, expectedHead: link.observationId, clientKey: key(), reason: "fixture retract" });
  }
  if (change === "binding") await f.sql`UPDATE opening_exam_bindings SET binding=jsonb_set(binding,'{skills}','[]'::jsonb) WHERE course_id=${x.courseId}`;
  if (change === "source") {
    const [source] = await f.sql`SELECT binding->>'packSourceId' AS id FROM opening_exam_bindings WHERE course_id=${x.courseId}`;
    await f.sql`UPDATE opening_sources SET version=version+1 WHERE id=${source!.id}`;
  }
  const projected = (await readCourseRouteObservations(f.sql, f.scope, x.courseId, false)).projected.filter(o => o.id === link.observationId);
  expect(projected.some(o => o.courseRequirement?.id === x.target.id)).toBe(false);
  expect(await readExamCourseEvidenceLinks(f.sql, { ...f.scope, ownerUserId: randomUUID() }, x.courseId)).toEqual([]);
  expect(await readExamCourseEvidenceLinks(f.sql, f.scope, randomUUID())).toEqual([]);
});

it("counts two distinct independently correct questions at the bound node", async () => {
  const x = await setup(); await x.confirm(); await x.all();
  expect((await x.progress()).status).toBe("verified");
  const evidence = await readCourseRouteObservations(f.sql, f.scope, x.courseId, false);
  const projected = evidence.projected.filter(row => row.courseRequirement?.id === x.target.id);
  expect(projected).toHaveLength(2);
  expect(projected.every(row => row.requirementKey === x.target.requirementKey)).toBe(true);
  expect(evidence.raw.filter(row => projected.some(p => p.id === row.id)).every(row => row.requirementKey?.startsWith("exam-skill:"))).toBe(true);
});

it("carries a real independently incorrect target exam answer through route start into compiler input", async () => {
  const x = await setup();
  const goal = await createOpeningLearningGoalRepository(f.sql).create(f.scope, { clientKey: key(), courseIds: [x.courseId], title: "Exam route goal", kind: "custom", targetDate: null,
    examDate: null, weeklyMinutes: 120, priority: 1, learningMode: "understand", successCriteria: "独立解释目标题型" });
  expect(goal).toMatchObject({ lifecycle: "active", courseIds: [x.courseId] });
  await x.confirm();
  // Diagnostic sorting starts with an unrelated skill; do not mistake it for the target.
  const first = await x.start();
  expect(first.currentAttempt!.questionId).toBe("other");
  const targetView = await x.next(await x.answer(first));
  const question = pack.questions.find(row => row.id === targetView.currentAttempt!.questionId)!;
  expect(question.skillId).toBe("target-skill");
  const wrongAnswer = question.options.find(option => option.id !== question.answer)!.id;
  const answered = await x.answer(targetView, wrongAnswer);
  expect(answered.currentAttempt).toMatchObject({ questionId: question.id, answer: wrongAnswer, correct: false, independent: true });

  const progress = await x.progress();
  expect(progress.status).toBe("needs_correction");
  const { requirement } = progress;
  const evidence = await readCourseRouteObservations(f.sql, f.scope, x.courseId, false);
  const raw = evidence.raw.filter(row => row.requirementKey === `exam-skill:${x.target.knowledgeNodeId}`);
  expect(raw).toHaveLength(1);
  const incorrect = raw[0]!;
  expect(incorrect).toMatchObject({ answer: wrongAnswer, outcome: "incorrect", assistance: "independent",
    itemVersionId: expect.any(String), serverEvaluation: { evaluatorVersion: "exam-choice-exact-v1", decision: "incorrect" } });
  const projected = evidence.projected.find(row => row.id === incorrect.id)!;
  const binding = { id: requirement.id, revision: requirement.revision, stableSkillId: requirement.stableSkillId, requirementKey: requirement.requirementKey };
  expect(projected).toMatchObject({ usableForCurrentVersion: "yes", independentAttempt: "yes", verifiedCorrect: "no", requirementKey: requirement.requirementKey });
  expect(projected.courseRequirement).toEqual(binding);
  expect(incorrect.requirementKey).toBe(`exam-skill:${requirement.knowledgeNodeId}`);
  expect(incorrect.requirementKey).not.toBe(requirement.requirementKey);
  const link = (await readExamCourseEvidenceLinks(f.sql, f.scope, x.courseId)).find(row => row.observationId === incorrect.id)!;
  expect(link).toMatchObject({ identityCurrent: true, nodeId: requirement.knowledgeNodeId, requirementKey: incorrect.requirementKey });
  expect(Date.parse(link.capturedAt!)).toBeGreaterThan(Date.parse(requirement.approvedAt!));

  // Exam activities are not route-managed predecessors: enter through start, not next.
  const started = await x.route.start(f.scope, x.courseId, { goalId: goal.id, expectedGoalRevision: goal.revision,
    requirementId: requirement.id, expectedRequirementRevision: requirement.revision, clientKey: key(), minutes: 20 });
  expect(started).toMatchObject({ kind: "ready", action: "targeted_explain", requirementId: requirement.id });
  if (started.kind !== "ready") throw new Error(JSON.stringify(started));
  const expectedFocus = { skillLabel: requirement.title, requirementKey: requirement.requirementKey, activityKind: "targeted_explain",
    reasonCode: "verified_incorrect", focusObservationId: incorrect.id, recentAssistance: ["independent"], strategyVersion: "course-route-1" };
  expect(started.activity.learnerFocus).toEqual(expectedFocus);
  const focusAttempt = { question: question.prompt, answer: wrongAnswer };
  expect(focusAttempt.answer).not.toBe(question.answer);
  expect(await readOpeningTeachingCompilerFocus(f.sql, f.scope, started.activity.id))
    .toEqual({ learnerFocus: expectedFocus, focusAttempt });

  vi.stubEnv("OPENING_TEACHING_COMPILER_ENABLED", "1");
  // Only the external embedding/ranking leaf is deterministic; all PG reads above
  // and inside the production worker builder remain real, including focus projection.
  const retrieve = vi.spyOn(materialRetrieval, "createOpeningMaterialRetriever").mockReturnValue(async (_scope, input) => ({ chunks: input.chunks, mode: "lexical" }));
  const pageImages = vi.fn(async () => []);
  const deps = createCompileTeachingUnitWorkerDeps(f.sql, { budget: createOpeningBudgetRepository(f.sql),
    chunks: createOpeningSourceChunksRepository(f.sql), privacy: createOpeningPrivacyRepository(f.sql), pageImages });
  const input = await deps.buildProviderInput!(f.scope, { mode: "generate", activityId: started.activity.id,
    expectedContentVersion: started.activity.contentVersion, sourceIds: started.activity.sourceIds, clientKey: key() });
  expect(retrieve).toHaveBeenCalledOnce();
  expect(input.chunks.length).toBeGreaterThan(0);
  expect(pageImages).not.toHaveBeenCalled();
  expect(input.imageParts).toEqual([]);
  // Inspect the structured learner data, not a snapshot of the surrounding prompt.
  const focusLine = input.text.split("\n").find(line => line.includes('"focusObservationId"'))!;
  const providerFocus = JSON.parse(focusLine.slice(focusLine.indexOf("{")));
  expect(providerFocus).toEqual({ ...expectedFocus, focusAttempt });
});

it("keeps exam evidence local even when an earlier local answer is unverified", async () => {
  const x = await setup(); await x.confirm();
  const ref = x.target.sourceRefs[0]!;
  const learning = createOpeningLearningRepository(f.sql);
  const session = await learning.createSession(f.scope, { courseId: x.courseId, skillLabel: x.target.title, sourceIds: [ref.sourceId] });
  const attempt = await createOpeningLearningAttemptRepository(f.sql).create(f.scope, { sessionId: session.id, clientKey: key(), requirementKey: x.target.requirementKey,
    problem: { sourceId: ref.sourceId, chunkId: ref.chunkId!, physicalPage: ref.page ?? 1, stemSnapshot: "Earlier local question", artifactKind: "reference_item" } });
  const binding = { id: x.target.id, revision: 1, stableSkillId: x.target.stableSkillId, requirementKey: x.target.requirementKey };
  await f.sql`UPDATE opening_learning_item_versions SET evaluation_spec=COALESCE(evaluation_spec,'{}'::jsonb) || ${f.sql.json({ courseRequirement: binding })}::jsonb WHERE id=${attempt.itemVersionId!}`;
  await learning.insertObservation(f.scope, { sessionId: session.id, attemptId: attempt.id, courseId: x.courseId, skillLabel: x.target.title, sourceIds: [ref.sourceId], problemId: attempt.problemId, clientKey: key(), answer: "unknown", outcome: "unverified", assistance: "independent", verdictSource: "self_report" });
  expect((await x.progress()).status).toBe("needs_verification");
  await x.all(); expect((await x.progress()).status).toBe("verified");
});

it("does not count captures made before route confirmation", async () => {
  const x = await setup(); await x.all(); await x.confirm();
  expect((await x.progress()).status).toBe("unobserved");
});

it("does not count a published answer mapped to a different node", async () => {
  const x = await setup(); await x.confirm(); const first = await x.start();
  expect(first.currentAttempt!.questionId).toBe("other");
  await x.answer(first); expect((await x.progress()).status).toBe("unobserved");
});

it("does not expose links across courses, workspaces or owners", async () => {
  const x = await setup(); await x.confirm(); await x.all();
  expect(await readExamCourseEvidenceLinks(f.sql, f.scope, x.courseId)).toHaveLength(3);
  expect(await readExamCourseEvidenceLinks(f.sql, f.scope, randomUUID())).toEqual([]);
  expect(await readExamCourseEvidenceLinks(f.sql, { ...f.scope, workspaceId: randomUUID() }, x.courseId)).toEqual([]);
  expect(await readExamCourseEvidenceLinks(f.sql, { ...f.scope, ownerUserId: randomUUID() }, x.courseId)).toEqual([]);
});

it("stops counting evidence when its current exam node binding is removed", async () => {
  const x = await setup(); await x.confirm(); await x.all();
  expect((await x.progress()).status).toBe("verified");
  await f.sql`UPDATE opening_exam_bindings SET binding=jsonb_set(binding,'{skills}','[]'::jsonb) WHERE course_id=${x.courseId}`;
  const links = await readExamCourseEvidenceLinks(f.sql, f.scope, x.courseId);
  expect(links).toHaveLength(3);
  expect(links.every(link => !link.identityCurrent)).toBe(true);
  expect((await x.progress()).status).toBe("unobserved");
});
