import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ExamPack, ExamSprintOverview } from "@aistudy/contracts";
import { evaluateEvidenceEligibility, resolveEvidenceAssistance } from "@aistudy/domain";
import { EXAM_LESSONS } from "../../packages/domain/src/opening/exam-sprint/lessons";
import { EXAM_TRAINING_QUESTIONS } from "../../packages/domain/src/opening/exam-sprint/training-questions";
import { createOpeningExamSprintRepository } from "../../packages/database/src/repositories/opening-exam-sprint";
import { createOpeningExamIntegrationRepository } from "../../packages/database/src/repositories/opening-exam-integration";
import { examPackDirectorySections, legacyExamPackSections, EXAM_DIRECTORY_FORMAT } from "../../packages/database/src/repositories/opening-exam-source-format";
import { readExamSourceExposure } from "../../packages/database/src/repositories/opening-exam-source-exposure";
import { mapLearningObservation } from "../../packages/database/src/repositories/opening-learning-facts";
import { readOpeningLearningEvidenceContext } from "../../packages/database/src/repositories/opening-learning-evidence-context";
import { reviseOpeningLearningObservation } from "../../packages/database/src/repositories/opening-observation-revisions";
import { parseExamSprintSnapshot } from "../../packages/database/src/repositories/opening-exam-sprint-snapshot";
import { readOpeningExamPublicSource } from "../../packages/database/src/repositories/opening-exam-public-source";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

const lesson = structuredClone(EXAM_LESSONS.find(item => item.id === "complex-arithmetic")!);
const pack: ExamPack = { id: "coverage-fixture", version: "1", title: "Coverage", description: "Syllabus",
  topics: [{ id: lesson.topicId, title: "Complex numbers" }], lessons: [lesson], sourceItems: [], weekPlan: [], limitations: [],
  questions: ["train-complex-product", "train-complex-quotient", "train-complex-modulus"]
    .map(id => structuredClone(EXAM_TRAINING_QUESTIONS.find(item => item.id === id)!)),
};
const key = () => `coverage:${randomUUID()}`;
let f: OpeningFixture;
let sprint: ReturnType<typeof createOpeningExamSprintRepository>;
let integration: ReturnType<typeof createOpeningExamIntegrationRepository>;
let sprintId: string, sourceId: string;
beforeAll(async () => {
  f = await createOpeningFixture();
  sprint = createOpeningExamSprintRepository(f.sql, pack);
  integration = createOpeningExamIntegrationRepository(f.sql, pack);
});
beforeEach(async () => {
  await f.sql`TRUNCATE opening_exam_sprints CASCADE`;
  const courseId = randomUUID();
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${courseId},${f.scope.workspaceId},'Coverage',${courseId})`;
  const bound = await integration.bind(f.scope, { clientKey: key(), courseId, milestoneId: null,
    expectedPackVersion: pack.version, createKnowledgeNodes: true, skills: [], materials: [] });
  sourceId = bound.binding!.packSourceId;
  const [row] = await f.sql`SELECT id FROM opening_exam_sprints WHERE workspace_id=${f.scope.workspaceId}`;
  sprintId = String(row!.id);
});
afterAll(async () => { await f?.close(); });
const start = () => sprint.act(f.scope, { action: "start", mode: "diagnostic", clientKey: key() });
const next = (view: ExamSprintOverview) => sprint.act(f.scope, { action: "next", runId: view.activeRun!.id, clientKey: key() });
function answer(view: ExamSprintOverview, clientKey = key()) {
  return sprint.act(f.scope, { action: "answer", attemptId: view.currentAttempt!.id,
    answer: pack.questions.find(item => item.id === view.currentAttempt!.questionId)!.answer, confidence: 4, clientKey });
}
async function raw() {
  const [row] = await f.sql`SELECT pack_snapshot,state FROM opening_exam_sprints WHERE id=${sprintId}`;
  return parseExamSprintSnapshot(row!.pack_snapshot, row!.state);
}
async function facts(examAttemptId: string) {
  const [row] = await f.sql`SELECT o.* FROM opening_exam_attempt_links l JOIN opening_learning_observations o ON o.id=l.observation_id
    WHERE l.sprint_id=${sprintId} AND l.exam_attempt_id=${examAttemptId}`;
  const record = mapLearningObservation(row!);
  const evidence = await readOpeningLearningEvidenceContext(f.sql, f.scope, record);
  return { record, evidence, eligibility: evaluateEvidenceEligibility(evidence.observation, evidence.context) };
}
/** Seed the actual historical serialization while keeping its referenced chunk identities. */
async function seedLegacyOriginal() {
  const sections = legacyExamPackSections(pack), body = sections.map(section => section.text).join("\n\n");
  const bytes = Buffer.byteLength(body, "utf8"), sha256 = createHash("sha256").update(body).digest("hex");
  for (let index = 0; index < sections.length; index++) {
    await f.sql`UPDATE opening_source_chunks SET text=${sections[index]!.text} WHERE source_id=${sourceId} AND source_version=0 AND page=${index + 1}`;
  }
  await f.sql`UPDATE opening_sources SET bytes=${bytes},sha256=${sha256} WHERE id=${sourceId}`;
  await f.sql`UPDATE opening_source_versions SET bytes=${bytes},sha256=${sha256} WHERE source_id=${sourceId} AND version=0`;
  return { body, bytes, sha256 };
}

describe("Sprint source exposure coverage", () => {
  it("recognizes new exact metadata originals and retains independent canonical grading", async () => {
    const source = await readOpeningExamPublicSource(f.sql, f.scope, sourceId, 0);
    expect(source!.text).toContain(EXAM_DIRECTORY_FORMAT);
    for (const body of [...lesson.steps, lesson.workedExample, ...lesson.pitfalls]) expect(source!.text).not.toContain(body);
    expect(await readExamSourceExposure(f.sql, f.scope, sprintId, pack)).toEqual({ kind: "metadata_only", packSourceId: sourceId, sourceVersion: 0 });
    const view = await answer(await start()), result = await facts(view.currentAttempt!.id);
    expect(view.currentAttempt).not.toHaveProperty("exposureCoverage");
    expect(result.eligibility).toMatchObject({ independentAttempt: "yes", verifiedCorrect: "yes" });
    expect((await integration.read(f.scope)).bkt.eligible).toBe(1);
  });

  it("captures legacy untracked availability as unknown without inventing reading, help, weakness or receipts", async () => {
    const original = await seedLegacyOriginal();
    expect(await readExamSourceExposure(f.sql, f.scope, sprintId, pack)).toEqual({ kind: "legacy_untracked_source", packSourceId: sourceId, sourceVersion: 0 });
    let view = await start();
    const coverage = { kind: "legacy_untracked_source", packSourceId: sourceId, sourceVersion: 0 };
    expect(view.currentAttempt!.exposureCoverage).toEqual(coverage);
    const clientKey = key();
    view = await answer(view, clientKey);
    expect((await answer(view, clientKey)).currentAttempt!.exposureCoverage).toEqual(coverage);
    expect(view.skills[0]!.status).toBe("untested");
    expect(view.currentAttempt!.help).toEqual([]);
    expect(view.currentAttempt!.lessonExposureIds).toEqual([]);
    expect(view.state.lessonExposures).toEqual([]);
    const result = await facts(view.currentAttempt!.id);
    expect(result.record.assistance).toBe("unknown");
    expect(result.evidence.context.examAttempt?.exposureCoverage).toBe("legacy_untracked_source");
    expect(result.eligibility.independentAttempt).toBe("unknown");
    expect(resolveEvidenceAssistance(result.evidence.observation, result.evidence.context)).toBe("unknown");
    expect((await integration.read(f.scope)).bkt.eligible).toBe(0);
    expect((await sprint.read(f.scope)).currentAttempt!.exposureCoverage).toEqual(coverage);
    expect((await sprint.export(f.scope)).attempts[0]!.exposureCoverage).toEqual(coverage);
    expect((await raw()).state.attempts[0]!.exposureCoverage).toEqual(coverage);
    const revised = await reviseOpeningLearningObservation(f.sql, f.scope, { rootObservationId: result.record.id,
      revisesObservationId: result.record.id, expectedHead: result.record.id, clientKey: key(), revisionKind: "replace", reason: "Claim independent",
      replacement: { answer: result.record.answer!, outcome: "correct", assistance: "independent", verdictSource: "self_report" } });
    const revisedEvidence = await readOpeningLearningEvidenceContext(f.sql, f.scope, revised.observation!);
    expect(revisedEvidence.context.examAttempt?.exposureCoverage).toBe("legacy_untracked_source");
    expect(evaluateEvidenceEligibility(revisedEvidence.observation, revisedEvidence.context).independentAttempt).toBe("unknown");
    expect(await readOpeningExamPublicSource(f.sql, f.scope, sourceId, 0)).toEqual({ text: original.body, bytes: original.bytes });
    const [saved] = await f.sql`SELECT sha256 FROM opening_source_versions WHERE source_id=${sourceId} AND version=0`;
    expect(saved!.sha256).toBe(original.sha256);
    const [counts] = await f.sql`SELECT (SELECT count(*)::int FROM opening_exam_help_receipts) AS receipts,
      (SELECT count(*)::int FROM opening_help_exposures WHERE workspace_id=${f.scope.workspaceId}) AS exposures`;
    expect(counts).toEqual({ receipts: 0, exposures: 0 });
  });

  it("adds source coverage at submission for pending attempts created before the legacy condition was captured", async () => {
    const pending = await start();
    expect(pending.currentAttempt).not.toHaveProperty("exposureCoverage");
    await seedLegacyOriginal();
    const submitted = await answer(pending);
    expect(submitted.currentAttempt!.exposureCoverage).toEqual({ kind: "legacy_untracked_source", packSourceId: sourceId, sourceVersion: 0 });
    expect((await facts(submitted.currentAttempt!.id)).eligibility.independentAttempt).toBe("unknown");
  });

  it("does not rewrite pre-feature answered facts while new pending attempts capture the legacy uncertainty", async () => {
    await seedLegacyOriginal();
    let view = await answer(await start());
    const firstId = view.currentAttempt!.id;
    // Reconstruct the already-submitted representation written by the pre-feature server.
    await f.sql`UPDATE opening_exam_sprints SET state=jsonb_set(state,'{attempts,0}',
      ((state->'attempts'->0)-'exposureCoverage') || '{"firstFamilyExposure":true}'::jsonb) WHERE id=${sprintId}`;
    await f.sql`UPDATE opening_exam_attempt_links SET first_family_exposure=TRUE WHERE sprint_id=${sprintId} AND exam_attempt_id=${firstId}`;
    await f.sql`UPDATE opening_learning_observations SET assistance='independent' WHERE id=(
      SELECT observation_id FROM opening_exam_attempt_links WHERE sprint_id=${sprintId} AND exam_attempt_id=${firstId})`;
    const frozen = structuredClone((await raw()).state.attempts[0]!);
    expect((await facts(firstId)).eligibility.independentAttempt).toBe("yes");
    view = await answer(await next(await sprint.read(f.scope)));
    expect(view.currentAttempt!.exposureCoverage?.kind).toBe("legacy_untracked_source");
    expect((await raw()).state.attempts[0]).toEqual(frozen);
    expect((await facts(firstId)).evidence.context.examAttempt).not.toHaveProperty("exposureCoverage");
    expect((await facts(firstId)).eligibility.independentAttempt).toBe("yes");
    expect((await integration.read(f.scope)).bkt.eligible).toBe(1);
  });

  it("keeps mismatched source hashes and invalid frozen source references unverifiable", async () => {
    await f.sql`UPDATE opening_source_chunks SET text=text || ' changed' WHERE source_id=${sourceId} AND page=2`;
    expect((await readExamSourceExposure(f.sql, f.scope, sprintId, pack))!.kind).toBe("unverifiable_source");
    let view = await answer(await start());
    expect(view.currentAttempt!.exposureCoverage?.kind).toBe("unverifiable_source");
    let result = await facts(view.currentAttempt!.id);
    expect(result.evidence.context.examAttempt?.exposureCoverage).toBe("unverifiable");
    expect(result.eligibility.independentAttempt).toBe("unknown");
    await f.sql`UPDATE opening_exam_sprints SET state=jsonb_set(state,'{attempts,0,exposureCoverage,packSourceId}',${f.sql.json(randomUUID())}) WHERE id=${sprintId}`;
    result = await facts(view.currentAttempt!.id);
    expect(result.evidence.context.examAttempt?.exposureCoverage).toBe("unverifiable");
    expect(result.eligibility.independentAttempt).toBe("unknown");
    expect((await integration.read(f.scope)).bkt.eligible).toBe(0);
    view = await sprint.read(f.scope);
    expect(view.currentAttempt!.exposureCoverage).toBeDefined();
    await f.sql`UPDATE opening_exam_sprints SET state=jsonb_set(state,'{attempts,0,exposureCoverage,sourceVersion}','-1'::jsonb) WHERE id=${sprintId}`;
    result = await facts(view.currentAttempt!.id);
    expect(result.evidence.context.examAttempt?.exposureCoverage).toBe("unverifiable");
    expect(result.eligibility.independentAttempt).toBe("unknown");
    await expect(sprint.read(f.scope)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("does not treat a later sanitized source version as proof that the legacy original was never exposed", async () => {
    await seedLegacyOriginal();
    const sections = examPackDirectorySections(pack), body = sections.map(section => section.text).join("\n\n");
    const bytes = Buffer.byteLength(body, "utf8"), sha256 = createHash("sha256").update(body).digest("hex");
    await f.sql`UPDATE opening_sources SET version=1,bytes=${bytes},sha256=${sha256} WHERE id=${sourceId}`;
    await f.sql`INSERT INTO opening_source_versions(source_id,version,workspace_id,bytes,sha256,availability)
      VALUES(${sourceId},1,${f.scope.workspaceId},${bytes},${sha256},'available')`;
    for (let index = 0; index < sections.length; index++) {
      await f.sql`INSERT INTO opening_source_chunks(source_id,source_version,page,text) VALUES(${sourceId},1,${index + 1},${sections[index]!.text})`;
    }
    expect(await readExamSourceExposure(f.sql, f.scope, sprintId, pack)).toEqual({ kind: "unverifiable_source", packSourceId: sourceId, sourceVersion: 1 });
    expect((await start()).currentAttempt!.exposureCoverage).toEqual({ kind: "unverifiable_source", packSourceId: sourceId, sourceVersion: 1 });
    expect((await readOpeningExamPublicSource(f.sql, f.scope, sourceId, 0))!.text).toContain(lesson.workedExample);
  });
});
