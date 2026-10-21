import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ExamPack, ExamSprintCommand, ExamSprintOverview } from "@aistudy/contracts";
import { evaluateEvidenceEligibility, resolveEvidenceAssistance } from "@aistudy/domain";
import { EXAM_LESSONS } from "../../packages/domain/src/opening/exam-sprint/lessons";
import { EXAM_TRAINING_QUESTIONS } from "../../packages/domain/src/opening/exam-sprint/training-questions";
import { validExamLessonExposure } from "../../packages/domain/src/opening/exam-sprint/lesson-exposure-mapping";
import { createOpeningExamSprintRepository } from "../../packages/database/src/repositories/opening-exam-sprint";
import { createOpeningExamIntegrationRepository } from "../../packages/database/src/repositories/opening-exam-integration";
import { parseExamSprintSnapshot } from "../../packages/database/src/repositories/opening-exam-sprint-snapshot";
import { readOpeningLearningEvidenceContext } from "../../packages/database/src/repositories/opening-learning-evidence-context";
import { mapLearningObservation } from "../../packages/database/src/repositories/opening-learning-facts";
import { reviseOpeningLearningObservation } from "../../packages/database/src/repositories/opening-observation-revisions";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

const lesson = structuredClone(EXAM_LESSONS.find(item => item.id === "complex-arithmetic")!);
const training = ["train-complex-product", "train-complex-quotient", "train-complex-modulus"]
  .map(id => structuredClone(EXAM_TRAINING_QUESTIONS.find(question => question.id === id)!));
const pack: ExamPack = {
  id: "lesson-fixture", version: "lesson-v1", title: "Lesson fixture", description: "Reviewed lesson capture",
  topics: [{ id: lesson.topicId, title: "Complex numbers" }], lessons: [lesson],
  questions: [...training, { ...structuredClone(training[0]!), id: "mock-a", pool: "mock-a" },
    { ...structuredClone(training[0]!), id: "mock-b", pool: "mock-b" }],
  sourceItems: [], weekPlan: [], limitations: [],
};
const key = () => `exam-lesson:${randomUUID()}`;
let f: OpeningFixture;
let sprint: ReturnType<typeof createOpeningExamSprintRepository>;
beforeAll(async () => {
  f = await createOpeningFixture();
  sprint = createOpeningExamSprintRepository(f.sql, pack);
});
beforeEach(async () => { await f.sql`TRUNCATE opening_exam_sprints CASCADE`; });
afterAll(async () => { await f?.close(); });

function open(view: ExamSprintOverview, clientKey = key()): Extract<ExamSprintCommand, { action: "open_lesson" }> {
  const identity = view.pack.lessons[0]!.exposureIdentity!;
  return { action: "open_lesson", lessonId: view.pack.lessons[0]!.id, expectedRunId: view.activeRun?.id ?? null,
    expectedAttemptId: view.currentAttempt?.id ?? null, clientKey, ...identity };
}
const start = (mode: "diagnostic" | "practice" | "mock-a" = "diagnostic") => sprint.act(f.scope, { action: "start", mode, clientKey: key() });
function answer(view: ExamSprintOverview) {
  const question = pack.questions.find(item => item.id === view.currentAttempt!.questionId)!;
  return sprint.act(f.scope, { action: "answer", attemptId: view.currentAttempt!.id, answer: question.answer, confidence: 4, clientKey: key() });
}
const finish = (view: ExamSprintOverview) => sprint.act(f.scope, { action: "finish", runId: view.activeRun!.id, clientKey: key() });
const next = (view: ExamSprintOverview) => sprint.act(f.scope, { action: "next", runId: view.activeRun!.id, clientKey: key() });
async function raw() {
  const [row] = await f.sql`SELECT pack_snapshot,state FROM opening_exam_sprints WHERE workspace_id=${f.scope.workspaceId}`;
  return parseExamSprintSnapshot(row!.pack_snapshot, row!.state);
}
async function bind(boundPack = pack) {
  const courseId = randomUUID();
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${courseId},${f.scope.workspaceId},'Lesson course',${courseId})`;
  await createOpeningExamIntegrationRepository(f.sql, boundPack).bind(f.scope, { clientKey: key(), courseId,
    milestoneId: null, expectedPackVersion: boundPack.version, createKnowledgeNodes: true, skills: [], materials: [] });
}
async function facts(examAttemptId: string) {
  const [row] = await f.sql`SELECT o.* FROM opening_exam_attempt_links l JOIN opening_learning_observations o ON o.id=l.observation_id
    JOIN opening_exam_sprints s ON s.id=l.sprint_id WHERE l.exam_attempt_id=${examAttemptId} AND s.workspace_id=${f.scope.workspaceId}`;
  const record = mapLearningObservation(row!);
  const evidence = await readOpeningLearningEvidenceContext(f.sql, f.scope, record);
  return { record, evidence, eligibility: evaluateEvidenceEligibility(evidence.observation, evidence.context) };
}

describe("persisted Sprint lesson authorization and evidence", () => {
  it("persists one authorization under concurrent identical replay and deduplicates different keys in the same run", async () => {
    const initial = await start(), command = open(initial);
    expect(initial.lessonContents).toEqual([]);
    const [first, replay] = await Promise.all([sprint.act(f.scope, command), sprint.act(f.scope, command)]);
    const again = await sprint.act(f.scope, open(first));
    expect(first.state.lessonExposures).toHaveLength(1);
    expect(replay.state.lessonExposures).toEqual(first.state.lessonExposures);
    expect(again.state.lessonExposures).toEqual(first.state.lessonExposures);
    expect(first.lessonContents).toEqual([{ exposureId: first.state.lessonExposures![0]!.id, lesson }]);
    const snapshot = await raw();
    expect(snapshot.state.lessonExposures![0]).toMatchObject({ clientKey: command.clientKey, packId: pack.id,
      packVersion: pack.version, runId: initial.activeRun!.id, lessonId: lesson.id,
      ...validExamLessonExposure(lesson)! });
    expect(snapshot.state.attempts[0]!.lessonExposureIds).toEqual([snapshot.state.lessonExposures![0]!.id]);
    expect(snapshot.state.attempts[0]!.help).toEqual([]);
    const exported = await sprint.export(f.scope);
    expect(exported.state.lessonExposures).toEqual(snapshot.state.lessonExposures);
    expect(exported.attempts[0]!.lessonExposureIds).toEqual(snapshot.state.attempts[0]!.lessonExposureIds);
    expect(parseExamSprintSnapshot(snapshot.pack, JSON.parse(JSON.stringify(snapshot.state))).state).toEqual(snapshot.state);
    await expect(sprint.act(f.scope, { ...command, mappingVersion: "different" })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejects forged owner, stale attempt/run and content versions without persisting a lesson", async () => {
    const initial = await start(), command = open(initial);
    await expect(sprint.act({ ...f.scope, ownerUserId: f.otherScope.ownerUserId }, command)).rejects.toMatchObject({ code: "NOT_FOUND" });
    for (const wrong of [{ expectedRunId: "old-run" }, { expectedAttemptId: null }, { packVersion: "old-version" },
      { contentFingerprint: "different" }, { mappingVersion: "old-map" }]) {
      await expect(sprint.act(f.scope, { ...command, ...wrong, clientKey: key() })).rejects.toMatchObject({ code: "CONFLICT" });
    }
    expect((await raw()).state.lessonExposures).toEqual([]);
    expect((await sprint.read(f.scope)).lessonContents).toEqual([]);
    const answered = await answer(initial), advanced = await next(answered);
    await expect(sprint.act(f.scope, { ...command, clientKey: key() })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(advanced.currentAttempt!.id).not.toBe(initial.currentAttempt!.id);
  });

  it("rolls back the exposure and delivers no content when recording its command receipt fails", async () => {
    const pending = await start(), clientKey = key();
    const constraint = `exam_lesson_failure_${randomUUID().replaceAll("-", "")}`;
    // Both identifiers are locally generated, and this constraint targets only this test key.
    await f.sql.unsafe(`ALTER TABLE opening_exam_sprint_commands ADD CONSTRAINT ${constraint} CHECK (client_key <> '${clientKey}')`);
    try {
      await expect(sprint.act(f.scope, open(pending, clientKey))).rejects.toMatchObject({ code: "23514" });
      expect((await raw()).state.lessonExposures).toEqual([]);
      expect((await sprint.read(f.scope)).lessonContents).toEqual([]);
    } finally {
      await f.sql.unsafe(`ALTER TABLE opening_exam_sprint_commands DROP CONSTRAINT ${constraint}`);
    }
  });

  it("rejects lesson delivery before a mock is handed in, including after the current answer", async () => {
    const sealed = await start("mock-a");
    await expect(sprint.act(f.scope, open(sealed))).rejects.toMatchObject({ code: "CONFLICT" });
    const answered = await answer(sealed);
    await expect(sprint.act(f.scope, open(answered))).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await raw()).state.lessonExposures).toEqual([]);
    const completed = await finish(answered);
    expect((await sprint.act(f.scope, open(completed))).state.lessonExposures).toHaveLength(1);
  });

  it("revalidates durable open receipts after the active context changes or a sealed mock starts", async () => {
    const initial = await sprint.read(f.scope), command = open(initial);
    await sprint.act(f.scope, command);
    let view = await start();
    await expect(sprint.act(f.scope, command)).rejects.toMatchObject({ code: "CONFLICT" });
    const duringRun = open(view);
    await sprint.act(f.scope, duringRun);
    view = await answer(view);
    await next(view);
    await expect(sprint.act(f.scope, duringRun)).rejects.toMatchObject({ code: "CONFLICT" });
    await finish(await sprint.read(f.scope));
    await start("mock-a");
    await expect(sprint.act(f.scope, command)).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await sprint.read(f.scope)).lessonContents).toEqual([]);
    expect((await raw()).state.lessonExposures).toHaveLength(2);
  });

  it("keeps old answered facts frozen, assists later same-run items, and carries only explicit example families into the next run", async () => {
    let view = await answer(await start());
    const first = structuredClone((await raw()).state.attempts[0]!);
    view = await sprint.act(f.scope, open(view));
    expect((await raw()).state.attempts[0]).toEqual(first);
    expect(view.attempts[0]!.independent).toBe(true);
    view = await answer(await next(view));
    expect(view.currentAttempt!.question.familyId).toBe("complex-quotient");
    expect(view.currentAttempt!.independent).toBe(false);
    expect(view.currentAttempt!.lessonExposureIds).toHaveLength(1);
    expect(view.currentAttempt!.seenExampleExposureIds).toHaveLength(1);
    await finish(view);
    view = await answer(await start("practice"));
    while (view.currentAttempt!.question.familyId !== "modulus-power") view = await answer(await next(view));
    expect(view.currentAttempt!.question.familyId).toBe("modulus-power");
    expect(view.currentAttempt!.lessonExposureIds).toEqual([]);
    expect(view.currentAttempt!.seenExampleExposureIds).toEqual([]);
    expect(view.currentAttempt!.independent).toBe(true);
  });

  it("treats only the explicitly displayed example family as previously seen across runs", async () => {
    const initial = await sprint.read(f.scope);
    await sprint.act(f.scope, open(initial));
    let view = await answer(await start());
    expect(view.currentAttempt!.question.familyId).toBe("complex-product");
    expect(view.currentAttempt!.independent).toBe(false);
    view = await answer(await next(view));
    expect(view.currentAttempt!.question.familyId).toBe("complex-quotient");
    expect(view.currentAttempt!.lessonExposureIds).toEqual([]);
    expect(view.currentAttempt!.seenExampleExposureIds).toHaveLength(1);
    expect(view.currentAttempt!.independent).toBe(false);
    await finish(view);
    view = await answer(await start("practice"));
    while (view.currentAttempt!.question.familyId !== "modulus-power") view = await answer(await next(view));
    expect(view.currentAttempt!.seenExampleExposureIds).toEqual([]);
    expect(view.currentAttempt!.independent).toBe(true);
  });

  it("reads old states as an empty ledger and preserves the persisted pack instead of switching to a new catalogue", async () => {
    const pending = await start(), command = open(pending);
    await answer(pending);
    await f.sql`UPDATE opening_exam_sprints SET state=(state-'lessonExposures') || jsonb_build_object('attempts',
      (SELECT jsonb_agg(a-'lessonExposureIds'-'seenExampleExposureIds'-'partialExampleExposureIds'-'firstFamilyExposure') FROM jsonb_array_elements(state->'attempts') a)),
      pack_snapshot=jsonb_set(pack_snapshot,'{lessons,0,summary}','"Unreviewed legacy wording"'::jsonb)
      WHERE workspace_id=${f.scope.workspaceId}`;
    const upgradedPack = structuredClone(pack); upgradedPack.version = "lesson-v2";
    const upgraded = createOpeningExamSprintRepository(f.sql, upgradedPack), view = await upgraded.read(f.scope);
    expect(view.pack.version).toBe(pack.version);
    expect(view.pack.lessons[0]!.exposureIdentity).toBeNull();
    expect(view.state.lessonExposures).toEqual([]);
    expect(view.attempts[0]).not.toHaveProperty("lessonExposureIds");
    await expect(upgraded.act(f.scope, { ...command, clientKey: key() })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await raw()).state.lessonExposures).toEqual([]);
  });

  it("publishes lesson assistance as canonical hinted evidence and retains it through an independence revision", async () => {
    await bind();
    let view = await start();
    view = await sprint.act(f.scope, open(view));
    view = await answer(view);
    const id = view.currentAttempt!.id, original = await facts(id);
    expect(original.record.assistance).toBe("hinted");
    expect(original.evidence.context.examAttempt).toMatchObject({ lessonAssistance: true, firstFamilyExposure: false });
    expect(original.eligibility.independentAttempt).toBe("no");
    const [counts] = await f.sql`SELECT (SELECT count(*)::int FROM opening_exam_help_receipts) AS exam_help,
      (SELECT count(*)::int FROM opening_help_exposures WHERE workspace_id=${f.scope.workspaceId}) AS generic_help`;
    expect(counts).toEqual({ exam_help: 0, generic_help: 0 });
    const revised = await reviseOpeningLearningObservation(f.sql, f.scope, {
      rootObservationId: original.record.id, revisesObservationId: original.record.id, expectedHead: original.record.id,
      clientKey: key(), revisionKind: "replace", reason: "Claim independent after lesson",
      replacement: { answer: original.record.answer!, outcome: "correct", assistance: "independent", verdictSource: "self_report" },
    });
    const evidence = await readOpeningLearningEvidenceContext(f.sql, f.scope, revised.observation!);
    expect(evidence.context.examAttempt?.lessonAssistance).toBe(true);
    expect(resolveEvidenceAssistance(evidence.observation, evidence.context)).toBe("hinted");
    expect(evaluateEvidenceEligibility(evidence.observation, evidence.context).independentAttempt).toBe("no");
    const [row] = await f.sql`SELECT state FROM opening_exam_sprints WHERE workspace_id=${f.scope.workspaceId}`;
    const snapshot = row!.state as { attempts: Array<Record<string, unknown>> };
    snapshot.attempts[0]!.lessonExposureIds = ["missing-exposure"];
    await f.sql`UPDATE opening_exam_sprints SET state=${f.sql.json(snapshot as never)} WHERE workspace_id=${f.scope.workspaceId}`;
    const unknown = await readOpeningLearningEvidenceContext(f.sql, f.scope, revised.observation!);
    expect(unknown.context.examAttempt?.lessonAssistance).toBeNull();
    expect(evaluateEvidenceEligibility(unknown.observation, unknown.context).independentAttempt).toBe("unknown");
  });

  it("updates canonical first-family qualification when a pending item opens its matching example", async () => {
    await bind();
    let view = await answer(await start());
    const firstId = view.currentAttempt!.id;
    expect((await facts(firstId)).eligibility.independentAttempt).toBe("yes");
    view = await next(view);
    view = await sprint.act(f.scope, open(view));
    view = await answer(view);
    const result = await facts(view.currentAttempt!.id);
    expect(result.evidence.context.examAttempt).toMatchObject({ firstFamilyExposure: false, lessonAssistance: true });
    expect(result.eligibility.independentAttempt).toBe("no");
    expect((await facts(firstId)).evidence.context.examAttempt).toMatchObject({ firstFamilyExposure: true, lessonAssistance: false });
    expect((await facts(firstId)).eligibility.independentAttempt).toBe("yes");
    expect((await createOpeningExamIntegrationRepository(f.sql, pack).read(f.scope)).bkt.eligible).toBe(1);
  });

  it("keeps confirmed partial-answer help non-independent across runs in canonical evidence and BKT", async () => {
    const curve = structuredClone(EXAM_LESSONS.find(item => item.id === "curve-analysis")!);
    const question = structuredClone(EXAM_TRAINING_QUESTIONS.find(item => item.id === "train-curve-closed-interval")!);
    const partialPack: ExamPack = { ...pack, topics: [{ id: curve.topicId, title: "Curve analysis" }],
      lessons: [curve], questions: [question] };
    const partialSprint = createOpeningExamSprintRepository(f.sql, partialPack);
    await bind(partialPack);
    await partialSprint.act(f.scope, open(await partialSprint.read(f.scope)));
    let view = await partialSprint.act(f.scope, { action: "start", mode: "diagnostic", clientKey: key() });
    view = await partialSprint.act(f.scope, { action: "answer", attemptId: view.currentAttempt!.id,
      answer: question.answer, confidence: 4, clientKey: key() });
    expect(view.currentAttempt!.lessonExposureIds).toEqual([]);
    expect(view.currentAttempt!.seenExampleExposureIds).toEqual([]);
    expect(view.currentAttempt!.partialExampleExposureIds).toHaveLength(1);
    expect(view.currentAttempt!.firstFamilyExposure).toBe(false);
    expect(view.currentAttempt!.independent).toBe(false);
    const result = await facts(view.currentAttempt!.id);
    expect(result.record.assistance).toBe("hinted");
    expect(result.evidence.context.examAttempt).toMatchObject({ lessonAssistance: false, partialExample: true, firstFamilyExposure: false });
    expect(result.eligibility.independentAttempt).toBe("no");
    expect(result.eligibility.reasonCodes).toContain("exam_partial_example_exposure");
    const revised = await reviseOpeningLearningObservation(f.sql, f.scope, {
      rootObservationId: result.record.id, revisesObservationId: result.record.id, expectedHead: result.record.id,
      clientKey: key(), revisionKind: "replace", reason: "Claim independent after a partial answer",
      replacement: { answer: result.record.answer!, outcome: "correct", assistance: "independent", verdictSource: "self_report" },
    });
    const evidence = await readOpeningLearningEvidenceContext(f.sql, f.scope, revised.observation!);
    expect(resolveEvidenceAssistance(evidence.observation, evidence.context)).toBe("hinted");
    expect(evaluateEvidenceEligibility(evidence.observation, evidence.context).independentAttempt).toBe("no");
    expect((await createOpeningExamIntegrationRepository(f.sql, partialPack).read(f.scope)).bkt.eligible).toBe(0);
  });
});
