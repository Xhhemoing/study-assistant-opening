import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ExamBindInput, ExamCourseBinding, ExamPack, ExamPaperInput, Scope } from "@aistudy/contracts";
import { createExamSprintState } from "@aistudy/domain";
import { EXAM_SPRINT_PACK } from "@aistudy/domain/exam-sprint-catalog";
import { createOpeningExamIntegrationRepository } from "../../packages/database/src/repositories/opening-exam-integration";
import { readCurrentExamNodeIds } from "../../packages/database/src/repositories/opening-exam-integration-facts";
import { createOpeningExamSprintRepository } from "../../packages/database/src/repositories/opening-exam-sprint";
import { reviseOpeningLearningObservation } from "../../packages/database/src/repositories/opening-observation-revisions";
import { createOpeningExamForecastRepository } from "../../packages/database/src/repositories/opening-exam-forecast";
import { createOpeningKnowledgeRepository } from "../../packages/database/src/repositories/opening-knowledge";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

const pack: ExamPack = {
  id: "forecast-fixture", version: "1", title: "Forecast", description: "Source annotations",
  topics: [{ id: "topic", title: "Topic" }],
  lessons: [{ id: "lesson", topicId: "topic", title: "Lesson", summary: "Summary", steps: [], workedExample: "Example", pitfalls: [] }],
  questions: ["first", "second"].map(skillId => ({ id: skillId, topicId: "topic", skillId, familyId: skillId, lessonId: "lesson",
    pool: "training", difficulty: "foundation", prompt: "Question", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
    answer: "a", explanation: "Explanation", hint: "Hint", estimatedMinutes: 2 })),
  sourceItems: [], weekPlan: [], limitations: [],
};
let f: OpeningFixture, sprintId: string, courseId: string;
let repository: ReturnType<typeof createOpeningExamForecastRepository>;
beforeAll(async () => { f = await createOpeningFixture(); repository = createOpeningExamForecastRepository(f.sql, pack); });
beforeEach(async () => {
  await f.sql`DELETE FROM opening_exam_sprints WHERE workspace_id=${f.scope.workspaceId}`;
  sprintId = randomUUID(); courseId = randomUUID();
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${courseId},${f.scope.workspaceId},'Exam course',${courseId})`;
  await f.sql`INSERT INTO opening_exam_sprints(id,workspace_id,owner_user_id,pack_snapshot,state)
    VALUES(${sprintId},${f.scope.workspaceId},${f.scope.ownerUserId},${f.sql.json(pack as never)},
      ${f.sql.json(createExamSprintState(new Date().toISOString()) as never)})`;
  const binding: ExamCourseBinding = { courseId, milestoneId: null, packSourceId: randomUUID(), boundAt: new Date().toISOString(),
    skills: ["first", "second"].map(skillId => ({ skillId, nodeId: randomUUID(), requirementKey: `exam:${skillId}` })), materials: [] };
  await f.sql`INSERT INTO opening_exam_bindings(sprint_id,course_id,binding) VALUES(${sprintId},${courseId},${f.sql.json(binding as never)})`;
});
afterAll(async () => {
  if (!f) return;
  const workspaces = [f.scope.workspaceId, f.otherScope.workspaceId];
  try {
    await f.sql.begin(async tx => {
      await tx`DELETE FROM opening_exam_sprints WHERE workspace_id=ANY(${workspaces}::uuid[])`;
      await tx`DELETE FROM opening_learning_sessions WHERE workspace_id=ANY(${workspaces}::uuid[])`;
      await tx`DELETE FROM opening_learning_item_versions WHERE workspace_id=ANY(${workspaces}::uuid[])`;
      await tx`DELETE FROM opening_source_versions WHERE workspace_id=ANY(${workspaces}::uuid[])`;
      await tx`DELETE FROM workspaces WHERE id=ANY(${workspaces}::uuid[])`;
    });
  } finally {
    await f.close();
  }
});

async function source(scope: Scope = f.scope) {
  const sourceId = randomUUID(), digest = sourceId.replaceAll("-", "").repeat(2);
  await f.sql`INSERT INTO opening_sources(id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state)
    VALUES(${sourceId},${scope.workspaceId},'Past exam.pdf','application/pdf',12,${digest},1,'uploaded','ready')`;
  await f.sql`INSERT INTO opening_source_versions(source_id,version,workspace_id,bytes,sha256,availability)
    VALUES(${sourceId},1,${scope.workspaceId},12,${digest},'available')`;
  await f.sql`INSERT INTO opening_source_chunks(source_id,source_version,page,text) VALUES(${sourceId},1,1,'Exam questions')`;
  return { sourceId, sourceVersion: 1 };
}
async function input(overrides: Partial<ExamPaperInput> = {}): Promise<ExamPaperInput> {
  return { clientKey: randomUUID(), ...await source(), teacher: "Teacher A", year: 2025, label: `Final exam ${randomUUID()}`, kind: "past_exam",
    skills: [{ skillId: "first", points: 12 }, { skillId: "second", points: 0 }], ...overrides };
}

async function completeMathMock(skills: ExamBindInput["skills"] = []) {
  await f.sql`DELETE FROM opening_exam_sprints WHERE id=${sprintId}`;
  const sprint = createOpeningExamSprintRepository(f.sql, EXAM_SPRINT_PACK);
  const integration = createOpeningExamIntegrationRepository(f.sql, EXAM_SPRINT_PACK);
  const forecast = createOpeningExamForecastRepository(f.sql, EXAM_SPRINT_PACK);
  const bound = await integration.bind(f.scope, {
    clientKey: randomUUID(), courseId, milestoneId: null, expectedPackVersion: EXAM_SPRINT_PACK.version,
    createKnowledgeNodes: true, skills, materials: [],
  });
  const started = await sprint.act(f.scope, { action: "start", mode: "mock-a", clientKey: randomUUID() });
  const attempt = started.currentAttempt!;
  const question = EXAM_SPRINT_PACK.questions.find(item => item.id === attempt.questionId)!;
  await sprint.act(f.scope, { action: "answer", attemptId: attempt.id, answer: question.answer, confidence: 4, clientKey: randomUUID() });
  await sprint.act(f.scope, { action: "finish", runId: started.activeRun!.id, clientKey: randomUUID() });
  return { binding: bound.binding!, examAttemptId: attempt.id, forecast, integration, skillId: question.skillId };
}

async function completeMathMockWithExternalNode() {
  const material = await source(), nodeId = randomUUID();
  const [chunk] = await f.sql`SELECT id FROM opening_source_chunks WHERE source_id=${material.sourceId}`;
  await f.sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,visibility)
    VALUES(${f.scope.workspaceId},${courseId},'source',${material.sourceId},'reference','private')`;
  await createOpeningKnowledgeRepository(f.sql).replace(f.scope, courseId, {
    expectedVersion: 0, sourceVersions: { [material.sourceId]: material.sourceVersion },
    snapshot: { courseId, version: 1, nodes: [{ id: nodeId, courseId, label: "Complex arithmetic", kind: "problem_type",
      status: "supported", evidenceChunkIds: [String(chunk!.id)] }], edges: [] },
  });

  const { binding, examAttemptId, forecast, integration, skillId } = await completeMathMock([
    { skillId: "complex-arithmetic", nodeId },
  ]);
  const formal = await integration.read(f.scope);
  const link = formal.links.find(item => item.examAttemptId === examAttemptId)!;
  expect(link).toMatchObject({ nodeId, publication: "published" });
  expect(formal.bkt.eligible).toBe(1);
  const paper = await input({ skills: [{ skillId, points: 10 }] });
  const registered = await forecast.record(f.scope, paper);
  expect(registered.shortMockReadiness).toBe("needs_external_calibration");
  expect(registered.papers).toHaveLength(1);
  return { binding, forecast, integration, link, nodeId, paper, registered };
}

describe("exam paper forecast repository", () => {
  it("registers owned current sources under the bound course and keeps teachers and sample kinds separate", async () => {
    const first = await input();
    const registered = await repository.record(f.scope, first);
    expect(registered).not.toHaveProperty("shortMockReadiness");
    expect(registered.papers).toHaveLength(1);
    expect(registered.papers[0]).toMatchObject({ courseId, sourceId: first.sourceId, sourceVersion: 1, teacher: "Teacher A" });
    expect(registered.topics[0]).toMatchObject({ skillId: "first", examinedPapers: 1, totalPapers: 1, probability: 2 / 3, meanPoints: 12 });
    expect(registered.topics[1]).toMatchObject({ skillId: "second", examinedPapers: 0, totalPapers: 1, meanPoints: 0 });
    const membership = await f.sql`SELECT role,visibility FROM course_asset_memberships WHERE course_id=${courseId} AND asset_id=${first.sourceId}`;
    expect(membership[0]).toMatchObject({ role: "reference", visibility: "private" });
    await repository.record(f.scope, await input({ kind: "sample" }));
    await repository.record(f.scope, await input({ kind: "exercise" }));
    await repository.record(f.scope, await input({ teacher: "Teacher B" }));
    const result = await repository.read(f.scope, "Teacher A");
    expect(result.papers).toHaveLength(3);
    expect(result.topics[0]?.totalPapers).toBe(1);
    expect((await repository.read(f.scope)).status).toBe("no_history");
    expect((await repository.read(f.otherScope, "Teacher A")).papers).toEqual([]);
  });

  it("replays the same command but rejects changed payloads and repeated source versions, including concurrent registrations", async () => {
    const value = await input();
    const first = await repository.record(f.scope, value);
    expect(await repository.record(f.scope, value)).toEqual(first);
    await expect(repository.record(f.scope, { ...value, label: "Changed" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(repository.record(f.scope, { ...value, clientKey: randomUUID(), teacher: "Teacher B" })).rejects.toMatchObject({ code: "CONFLICT" });
    const concurrent = await input();
    const results = await Promise.allSettled([repository.record(f.scope, concurrent),
      repository.record(f.scope, { ...concurrent, clientKey: randomUUID() })]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "CONFLICT" } });
    expect((await repository.read(f.scope, "Teacher A")).papers).toHaveLength(2);
  });

  it("reports readiness without creating a sprint only for the Math I short-mock pack", async () => {
    const read = (initialPack: ExamPack) => createOpeningExamForecastRepository(f.sql, initialPack).read(f.otherScope);
    expect((await read(EXAM_SPRINT_PACK)).shortMockReadiness).toBe("needs_personal_independent_evidence");
    expect((await read({
      ...EXAM_SPRINT_PACK, questions: EXAM_SPRINT_PACK.questions.filter(question => question.pool === "mock-b"),
    })).shortMockReadiness).toBe("needs_personal_independent_evidence");
    expect(await read({ ...EXAM_SPRINT_PACK, id: "another-pack" })).not.toHaveProperty("shortMockReadiness");
    expect(await read({
      ...EXAM_SPRINT_PACK, questions: EXAM_SPRINT_PACK.questions.filter(question => question.pool === "training"),
    })).not.toHaveProperty("shortMockReadiness");
    expect(await f.sql`SELECT id FROM opening_exam_sprints WHERE workspace_id=${f.otherScope.workspaceId}`).toEqual([]);
    const supportedInitialPack = createOpeningExamForecastRepository(f.sql, EXAM_SPRINT_PACK);
    expect(await supportedInitialPack.read(f.scope)).not.toHaveProperty("shortMockReadiness");
  });

  it("updates reads, new registrations and receipt replays using live formal short-mock evidence", async () => {
    await f.sql`DELETE FROM opening_exam_sprints WHERE id=${sprintId}`;
    const sprint = createOpeningExamSprintRepository(f.sql, EXAM_SPRINT_PACK);
    const integration = createOpeningExamIntegrationRepository(f.sql, EXAM_SPRINT_PACK);
    const forecast = createOpeningExamForecastRepository(f.sql, EXAM_SPRINT_PACK);
    await integration.bind(f.scope, {
      clientKey: randomUUID(), courseId, milestoneId: null, expectedPackVersion: EXAM_SPRINT_PACK.version,
      createKnowledgeNodes: true, skills: [], materials: [],
    });
    const started = await sprint.act(f.scope, { action: "start", mode: "mock-a", clientKey: randomUUID() });
    const attempt = started.currentAttempt!;
    const question = EXAM_SPRINT_PACK.questions.find(item => item.id === attempt.questionId)!;
    await sprint.act(f.scope, { action: "answer", attemptId: attempt.id, answer: question.answer, confidence: 4, clientKey: randomUUID() });

    const paper = await input({ skills: [{ skillId: question.skillId, points: 10 }] });
    const waiting = await forecast.record(f.scope, paper);
    expect(waiting.shortMockReadiness).toBe("needs_personal_independent_evidence");
    expect(waiting.papers).toHaveLength(1);
    expect(await forecast.read(f.scope, paper.teacher)).toEqual(waiting);
    expect(await forecast.record(f.scope, paper)).toEqual(waiting);

    await sprint.act(f.scope, { action: "finish", runId: started.activeRun!.id, clientKey: randomUUID() });
    const formal = await integration.read(f.scope);
    expect(formal.bkt.eligible).toBe(1);
    const link = formal.links.find(item => item.examAttemptId === attempt.id)!;
    expect(link.publication).toBe("published");
    const observationId = link.observationId!;
    const needsCalibration = await forecast.read(f.scope, paper.teacher);
    expect(needsCalibration).toEqual({ ...waiting, shortMockReadiness: "needs_external_calibration" });
    expect(await forecast.record(f.scope, paper)).toEqual(needsCalibration);
    const freshPaper = await input({ skills: paper.skills });
    const afterFresh = await forecast.record(f.scope, freshPaper);
    expect(afterFresh.shortMockReadiness).toBe("needs_external_calibration");
    expect(afterFresh.papers).toHaveLength(2);
    expect(await forecast.read(f.scope, "No matching teacher")).toMatchObject({
      papers: [], shortMockReadiness: "needs_external_calibration",
    });
    expect((await forecast.read(f.otherScope)).shortMockReadiness).toBe("needs_personal_independent_evidence");

    await reviseOpeningLearningObservation(f.sql, f.scope, {
      rootObservationId: observationId, revisesObservationId: observationId, expectedHead: observationId,
      clientKey: randomUUID(), reason: "Retract the captured answer", revisionKind: "retract",
    });
    expect((await integration.read(f.scope)).bkt.eligible).toBe(0);
    const invalidated = await forecast.read(f.scope, paper.teacher);
    expect(invalidated).toEqual({ ...afterFresh, shortMockReadiness: "needs_personal_independent_evidence" });
    expect(await forecast.record(f.scope, paper)).toEqual(invalidated);
  });

  it("requires a formal fact and qualifies an independent B-form skill after an externally assisted answer", async () => {
    await f.sql`DELETE FROM opening_exam_sprints WHERE id=${sprintId}`;
    const sprint = createOpeningExamSprintRepository(f.sql, EXAM_SPRINT_PACK);
    const integration = createOpeningExamIntegrationRepository(f.sql, EXAM_SPRINT_PACK);
    const forecast = createOpeningExamForecastRepository(f.sql, EXAM_SPRINT_PACK);

    const unbound = await sprint.act(f.scope, { action: "start", mode: "mock-a", clientKey: randomUUID() });
    const first = unbound.currentAttempt!;
    const firstQuestion = EXAM_SPRINT_PACK.questions.find(item => item.id === first.questionId)!;
    await sprint.act(f.scope, { action: "answer", attemptId: first.id, answer: firstQuestion.answer, confidence: 4, clientKey: randomUUID() });
    await sprint.act(f.scope, { action: "finish", runId: unbound.activeRun!.id, clientKey: randomUUID() });
    expect((await forecast.read(f.scope)).shortMockReadiness).toBe("needs_personal_independent_evidence");
    await integration.bind(f.scope, {
      clientKey: randomUUID(), courseId, milestoneId: null, expectedPackVersion: EXAM_SPRINT_PACK.version,
      createKnowledgeNodes: true, skills: [], materials: [],
    });

    const bound = await sprint.act(f.scope, { action: "start", mode: "mock-b", clientKey: randomUUID() });
    const assisted = bound.currentAttempt!;
    const assistedQuestion = EXAM_SPRINT_PACK.questions.find(item => item.id === assisted.questionId)!;
    await sprint.act(f.scope, { action: "help", attemptId: assisted.id, kind: "external", clientKey: randomUUID() });
    await sprint.act(f.scope, { action: "answer", attemptId: assisted.id, answer: assistedQuestion.answer, confidence: 4, clientKey: randomUUID() });
    const next = await sprint.act(f.scope, { action: "next", runId: bound.activeRun!.id, clientKey: randomUUID() });
    const independent = next.currentAttempt!;
    const independentQuestion = EXAM_SPRINT_PACK.questions.find(item => item.id === independent.questionId)!;
    expect(independentQuestion.skillId).toBe("complex-roots");
    await sprint.act(f.scope, { action: "answer", attemptId: independent.id, answer: independentQuestion.answer, confidence: 4, clientKey: randomUUID() });
    await sprint.act(f.scope, { action: "finish", runId: bound.activeRun!.id, clientKey: randomUUID() });

    const formal = await integration.read(f.scope);
    expect(formal.bkt.eligible).toBe(1);
    const observationId = formal.links.find(link => link.examAttemptId === independent.id)!.observationId!;
    expect((await forecast.read(f.scope)).shortMockReadiness).toBe("needs_external_calibration");
    await reviseOpeningLearningObservation(f.sql, f.scope, {
      rootObservationId: observationId, revisesObservationId: observationId, expectedHead: observationId,
      clientKey: randomUUID(), reason: "Retract the independent answer", revisionKind: "retract",
    });
    expect((await forecast.read(f.scope)).shortMockReadiness).toBe("needs_personal_independent_evidence");
  });

  it("returns the legacy empty history and withdraws short-mock readiness after course archive", async () => {
    const { forecast, skillId } = await completeMathMock();
    const paper = await input({ skills: [{ skillId, points: 10 }] });
    const registered = await forecast.record(f.scope, paper);
    expect(registered).toMatchObject({ status: "limited_history", shortMockReadiness: "needs_external_calibration" });
    expect(registered.papers).toHaveLength(1);
    const emptyHistory = await forecast.read(f.scope, "Unregistered teacher");
    expect(emptyHistory).toMatchObject({ status: "no_history", papers: [] });

    await f.sql`UPDATE courses SET archived_at=now() WHERE id=${courseId} AND workspace_id=${f.scope.workspaceId}`;
    await expect(forecast.record(f.scope, await input({ skills: paper.skills }))).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(forecast.record(f.scope, paper)).rejects.toMatchObject({ code: "NOT_FOUND", examReceiptCommitted: true });
    expect(await forecast.read(f.scope, paper.teacher)).toEqual({
      ...emptyHistory, teacher: paper.teacher, shortMockReadiness: "needs_personal_independent_evidence",
    });
  });

  it("withdraws readiness across reads and registrations when only the captured pack source is unlinked", async () => {
    const { binding, forecast, integration, link, nodeId, paper, registered } = await completeMathMockWithExternalNode();
    const removed = await f.sql`DELETE FROM course_asset_memberships
      WHERE workspace_id=${f.scope.workspaceId} AND course_id=${courseId}
        AND asset_type='source' AND asset_id=${binding.packSourceId} RETURNING asset_id`;
    expect(removed).toEqual([{ asset_id: binding.packSourceId }]);
    expect((await readCurrentExamNodeIds(f.sql, f.scope, binding)).has(nodeId)).toBe(true);
    const afterUnlink = await integration.read(f.scope);
    expect(afterUnlink.bkt.eligible).toBe(1);
    expect(afterUnlink.links).toContainEqual(link);
    expect(await f.sql`SELECT o.source_ids,o.source_versions,s.version,v.availability FROM opening_learning_observations o
      JOIN opening_sources s ON s.workspace_id=o.workspace_id AND s.id=${binding.packSourceId}
      JOIN opening_source_versions v ON v.workspace_id=s.workspace_id AND v.source_id=s.id AND v.version=s.version
      WHERE o.id=${link.observationId!} AND o.workspace_id=${f.scope.workspaceId} AND o.owner_user_id=${f.scope.ownerUserId}`)
      .toMatchObject([{ source_ids: [binding.packSourceId], source_versions: { [binding.packSourceId]: 0 },
        version: 0, availability: "available" }]);

    const read = await forecast.read(f.scope, paper.teacher);
    const replay = await forecast.record(f.scope, paper);
    const another = await input({ skills: paper.skills });
    const fresh = await forecast.record(f.scope, another);
    expect(read.papers).toEqual(registered.papers);
    expect(replay).toEqual(read);
    expect(fresh.papers.map(item => item.sourceId)).toEqual([paper.sourceId, another.sourceId]);
    expect({ read: read.shortMockReadiness, replay: replay.shortMockReadiness, fresh: fresh.shortMockReadiness }).toEqual({
      read: "needs_personal_independent_evidence", replay: "needs_personal_independent_evidence",
      fresh: "needs_personal_independent_evidence",
    });
  });

  it.each(["parsing", "version availability"] as const)("rechecks captured pack %s for reads and registrations without another learner attempt", async dependency => {
    const { binding, forecast, integration, link, nodeId, paper, registered } = await completeMathMockWithExternalNode();
    const [current, blocked] = dependency === "parsing" ? ["ready", "failed"] : ["available", "unknown"];
    const changePackState = (before: string, after: string) => dependency === "parsing"
      ? f.sql`UPDATE opening_sources SET parse_state=${after}
          WHERE workspace_id=${f.scope.workspaceId} AND id=${binding.packSourceId} AND parse_state=${before}
          RETURNING version,parse_state AS state`
      : f.sql`UPDATE opening_source_versions SET availability=${after}
          WHERE workspace_id=${f.scope.workspaceId} AND source_id=${binding.packSourceId}
            AND version=0 AND availability=${before}
          RETURNING version,availability AS state`;
    expect(await changePackState(current, blocked)).toEqual([{ version: 0, state: blocked }]);
    expect(await f.sql`SELECT asset_id FROM course_asset_memberships WHERE workspace_id=${f.scope.workspaceId}
      AND course_id=${courseId} AND asset_type='source' AND asset_id=${binding.packSourceId}`)
      .toEqual([{ asset_id: binding.packSourceId }]);
    expect((await readCurrentExamNodeIds(f.sql, f.scope, binding)).has(nodeId)).toBe(true);
    const formal = await integration.read(f.scope);
    expect(formal.bkt.eligible).toBe(1);
    expect(formal.links).toContainEqual(link);

    const another = await input({ skills: paper.skills });
    const failed = {
      read: await forecast.read(f.scope, paper.teacher),
      replay: await forecast.record(f.scope, paper),
      fresh: await forecast.record(f.scope, another),
    };
    const missingEvidence = "needs_personal_independent_evidence";
    expect(failed.read.papers).toEqual(registered.papers);
    expect(failed.fresh.papers.map(item => item.sourceId)).toEqual([paper.sourceId, another.sourceId]);
    expect(failed).toMatchObject({
      read: { shortMockReadiness: missingEvidence },
      replay: { shortMockReadiness: missingEvidence },
      fresh: { shortMockReadiness: missingEvidence },
    });
    expect(failed.replay).toEqual(failed.read);

    expect(await changePackState(blocked, current)).toEqual([{ version: 0, state: current }]);
    const restoredRead = await forecast.read(f.scope, paper.teacher);
    const restoredReplay = await forecast.record(f.scope, paper);
    const third = await input({ skills: paper.skills });
    const restoredFresh = await forecast.record(f.scope, third);
    expect(restoredRead).toEqual({ ...failed.fresh, shortMockReadiness: "needs_external_calibration" });
    expect(restoredReplay).toEqual(restoredRead);
    expect(restoredFresh.shortMockReadiness).toBe("needs_external_calibration");
    expect(restoredFresh.papers.map(item => item.sourceId)).toEqual([paper.sourceId, another.sourceId, third.sourceId]);
    expect((await integration.read(f.scope)).links).toEqual(formal.links);
  });

  it("rejects foreign ownership, foreign sources, unknown skills, archived courses and missing bindings", async () => {
    const value = await input(), forged = { ...f.scope, ownerUserId: f.otherScope.ownerUserId };
    await expect(repository.read(forged)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(repository.record(forged, value)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(repository.record(f.scope, { ...value, ...await source(f.otherScope) })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(repository.record(f.scope, { ...value, skills: [{ skillId: "unknown", points: 5 }] })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(repository.record(f.scope, { ...value, year: new Date().getUTCFullYear() + 1 })).rejects.toMatchObject({ code: "VALIDATION" });
    await f.sql`UPDATE courses SET archived_at=now() WHERE id=${courseId}`;
    await expect(repository.record(f.scope, value)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await f.sql`UPDATE courses SET archived_at=NULL WHERE id=${courseId}`;
    await f.sql`DELETE FROM opening_exam_bindings WHERE sprint_id=${sprintId}`;
    await expect(repository.record(f.scope, value)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await f.sql`SELECT id FROM opening_exam_papers WHERE sprint_id=${sprintId}`).toHaveLength(0);
  });

  it("rejects duplicate uploads and different scans of the same named exam without increasing sample size", async () => {
    const original = await input();
    await repository.record(f.scope, original);
    const upload = await input({ teacher: "Different label", label: "Renamed upload" });
    await f.sql`UPDATE opening_source_versions SET sha256=(SELECT sha256 FROM opening_source_versions
      WHERE source_id=${original.sourceId} AND version=1) WHERE source_id=${upload.sourceId}`;
    await expect(repository.record(f.scope, upload)).rejects.toMatchObject({ code: "CONFLICT" });
    const scan = await input({ teacher: original.teacher, year: original.year, label: original.label });
    await expect(repository.record(f.scope, scan)).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await repository.read(f.scope, original.teacher)).topics[0]?.totalPapers).toBe(1);
    expect(await f.sql`SELECT id FROM opening_exam_papers WHERE sprint_id=${sprintId}`).toHaveLength(1);
  });

  it("rejects unavailable, excluded, unparsed or empty sources and never enrolls them in a course", async () => {
    const value = await input();
    await f.sql`INSERT INTO opening_privacy_exclusions(workspace_id,source_id) VALUES(${f.scope.workspaceId},${value.sourceId})`;
    await expect(repository.record(f.scope, value)).rejects.toMatchObject({ code: "CONFLICT" });
    await f.sql`DELETE FROM opening_privacy_exclusions WHERE source_id=${value.sourceId}`;
    await f.sql`UPDATE opening_source_versions SET availability='unavailable' WHERE source_id=${value.sourceId}`;
    await expect(repository.record(f.scope, value)).rejects.toMatchObject({ code: "CONFLICT" });
    await f.sql`UPDATE opening_source_versions SET availability='available' WHERE source_id=${value.sourceId}`;
    await f.sql`UPDATE opening_sources SET parse_state='queued' WHERE id=${value.sourceId}`;
    await expect(repository.record(f.scope, value)).rejects.toMatchObject({ code: "CONFLICT" });
    await f.sql`UPDATE opening_sources SET parse_state='ready' WHERE id=${value.sourceId}`;
    await f.sql`UPDATE opening_source_chunks SET text='  ' WHERE source_id=${value.sourceId}`;
    await expect(repository.record(f.scope, value)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await f.sql`SELECT id FROM course_asset_memberships WHERE course_id=${courseId}`).toHaveLength(0);
  });

  it("removes stale, excluded, unavailable or unlinked registered sources from all reads", async () => {
    const values = await Promise.all([input(), input(), input(), input()]);
    for (const value of values) await repository.record(f.scope, value);
    const [stale, excluded, unavailable, unlinked] = values as [ExamPaperInput, ExamPaperInput, ExamPaperInput, ExamPaperInput];
    await f.sql`UPDATE opening_sources SET version=2 WHERE id=${stale.sourceId}`;
    await expect(repository.record(f.scope, { ...stale, clientKey: randomUUID() })).rejects.toMatchObject({ code: "CONFLICT" });
    await f.sql`INSERT INTO opening_privacy_exclusions(workspace_id,source_id) VALUES(${f.scope.workspaceId},${excluded.sourceId})`;
    await f.sql`UPDATE opening_source_versions SET availability='unavailable' WHERE source_id=${unavailable.sourceId}`;
    await f.sql`DELETE FROM course_asset_memberships WHERE course_id=${courseId} AND asset_id=${unlinked.sourceId}`;
    expect((await repository.read(f.scope, "Teacher A")).papers).toEqual([]);
    expect((await repository.record(f.scope, excluded)).papers).toEqual([]);
  });

  it("fails closed on corrupt persisted annotations instead of manufacturing a forecast", async () => {
    const value = await input();
    await repository.record(f.scope, value);
    await f.sql`UPDATE opening_exam_papers SET skills='[{"skillId":"first","points":-1}]'::jsonb WHERE sprint_id=${sprintId}`;
    await expect(repository.read(f.scope, "Teacher A")).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
