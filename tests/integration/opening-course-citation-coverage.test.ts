import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { assembleTeachingEvidencePack, compileCurrentActivity, proposeTeachingOutline } from "@aistudy/ai";
import {
  createOpeningBudgetRepository, createOpeningJobRepository, createOpeningLearningGoalRepository,
  createOpeningPrivacyRepository, createOpeningSourceChunksRepository, createOpeningTeachingContentRepository,
} from "@aistudy/database";
import { createOpeningCourseRouteRepository } from "../../packages/database/src/repositories/opening-course-route";
import { createCompileTeachingUnitWorkerDeps } from "../../apps/worker/src/runtime/compile-teaching-unit-wiring";
import { createCompileTeachingUnitHandler } from "../../apps/worker/src/jobs/compile-teaching-unit";
import { rankPedagogy } from "../fixtures/opening/teaching/rank-pedagogy";
import { backupRows } from "./opening-backup-records-fixture";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

let f: OpeningFixture;
beforeEach(async () => {
  f = await createOpeningFixture();
  vi.stubEnv("OPENING_TEACHING_COMPILER_ENABLED", "1");
  vi.stubEnv("OPENING_TEACHING_VALIDATION_ENABLED", "0");
});
afterEach(async () => { vi.unstubAllEnvs(); await f?.close(); });

async function seed() {
  const courseId = randomUUID(), sourceId = await backupRows(f.sql, f.scope).source("uploaded", 0);
  const chunkId = await backupRows(f.sql, f.scope).chunk(sourceId, 0);
  await f.sql`UPDATE opening_source_chunks SET image_object_key=NULL WHERE id=${chunkId}`;
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${courseId},${f.scope.workspaceId},'Citation coverage',${courseId})`;
  await f.sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,visibility)
    VALUES(${f.scope.workspaceId},${courseId},'source',${sourceId},'core','course')`;
  const goal = await createOpeningLearningGoalRepository(f.sql).create(f.scope, { clientKey: randomUUID(), courseIds: [courseId],
    title: "核对全部内容", kind: "custom", targetDate: null, examDate: null, weeklyMinutes: 120, priority: 1,
    learningMode: "understand", successCriteria: "逐块核对而不是只看首个引用" });
  const requirementId = randomUUID(), repo = createOpeningCourseRouteRepository(f.sql, { compilerEnabled: true });
  await repo.confirm(f.scope, courseId, { expectedRevisions: [], confirmScope: true, requirements: [{
    id: requirementId, stableSkillId: randomUUID(), knowledgeNodeId: null, requirementKey: "citation-population", title: "全部内容",
    position: 0, mandatory: true, goalIds: [goal.id], prerequisiteIds: [], sourceRefs: [{ sourceId, sourceVersion: 0, chunkId }],
    verification: { kind: "unavailable", status: "missing", exerciseKeys: [], rubric: null, missingReasons: ["未核对"] }, origin: "confirmed",
  }] });
  const result = await repo.start(f.scope, courseId, { goalId: goal.id, expectedGoalRevision: 1,
    requirementId, expectedRequirementRevision: 1, clientKey: randomUUID(), minutes: 20 });
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") throw new Error(result.reason);
  return { repo, courseId, sourceId, chunkId, activity: result.activity };
}

/** Real production compiler wiring, job, library revision and publication. Only model output is fake. */
async function compile(x: Awaited<ReturnType<typeof seed>>) {
  const chunks = createOpeningSourceChunksRepository(f.sql);
  const deps = createCompileTeachingUnitWorkerDeps(f.sql, { budget: createOpeningBudgetRepository(f.sql), chunks,
    privacy: createOpeningPrivacyRepository(f.sql) });
  deps.callModel = async (_scope, _input, options) => {
    await options.beforeSend?.();
    return { text: JSON.stringify({ blocks: [
      { type: "text", text: "source evidence", citedChunkIds: [x.chunkId] },
      { type: "formula", text: "A x = 0" },
      { type: "example", text: "source evidence example", citedChunkIds: [x.chunkId] },
      ...[0, 1, 2].flatMap(index => [
        { type: "prompt", text: `解释零空间的含义（${index}）`, citedChunkIds: index === 0 ? [x.chunkId] : [] },
        { type: "answer_key", text: `private-solution-${index}`, ...rankPedagogy,
          hints: { direction: "从齐次方程入手。", concept: "零空间是齐次方程的解集。", firstStep: "写出对应的齐次方程。" },
          citedChunkIds: index === 0 ? [x.chunkId] : index === 1 ? [randomUUID()] : [] },
      ]),
    ] }), citedChunkIds: [], requestId: null, candidates: [], inputTokens: 10, outputTokens: 10 };
  };
  const [row] = await f.sql`SELECT id FROM opening_jobs WHERE workspace_id=${f.scope.workspaceId}
    AND kind='compile-teaching-unit' AND payload->>'activityId'=${x.activity.id}`;
  const job = await createOpeningJobRepository(f.sql).claim(String(row!.id));
  expect(job).not.toBeNull();
  await createCompileTeachingUnitHandler(deps)(job!, job!.payload);
  const content = createOpeningTeachingContentRepository(f.sql);
  const spec = await content.getActivitySpec(f.scope, x.activity.id);
  expect(spec?.version).toBe(1);
  const revision = await content.readRevision(f.scope, spec!.documentId, spec!.revisionNumber);
  return { content, spec: spec!, revision };
}

it("persists and reads every role independently; one cited teach block is not complete coverage", async () => {
  const x = await seed(), { content, spec, revision } = await compile(x);
  expect(revision.blocks).toHaveLength(9);
  const statuses = ["bound", "missing", "bound", "bound", "bound", "missing", "mismatch", "missing", "missing"];
  for (const [index, ref] of spec.blockOrder.entries()) {
    const block = revision.blocks.find(block => block.id === ref.blockId)!;
    expect(block.content.citationBinding).toEqual({ blockId: ref.blockId, role: ref.role, status: statuses[index],
      refs: statuses[index] === "bound" ? [{ sourceId: x.sourceId, sourceVersion: 0, chunkId: x.chunkId, page: 1 }] : [],
      factualSupport: "unverified" });
  }
  expect(spec.verificationStatus).toBe("needs_check");
  const route = await x.repo.read(f.scope, x.courseId, x.activity.id);
  expect(route.requirements[0]).toMatchObject({ compilation: { saved: true, contentVersion: 1 },
    questionCoverage: { savedQuestions: 3, withReferenceAnswers: 3, issuedQuestions: 0 } });
  // The route's existing question facts are not citation coverage. Aggregate
  // citation projection awaits ownership of the shared contract/repository hunk.
  expect(route.requirements[0]!.status).not.toBe("verified");
  const client = await content.getClientInit(f.scope, x.activity.id);
  expect(client!.blocks.filter(block => block.role === "answer_key").every(block => block.content === null)).toBe(true);
  expect(JSON.stringify(client)).not.toContain("private-solution");
  await expect(content.readRevision(f.otherScope, spec.documentId, spec.revisionNumber)).rejects.toBeDefined();
  await expect(x.repo.read(f.otherScope, x.courseId)).rejects.toBeDefined();
  expect(await content.publishActivitySpec(f.scope, { activityId: x.activity.id, teachingUnitId: spec.teachingUnitId,
    expectedVersion: 0, revisionNumber: spec.revisionNumber, blockOrder: spec.blockOrder, sourceRefs: spec.sourceRefs,
    goals: spec.goals, verificationStatus: spec.verificationStatus, generationConfig: spec.generationConfig })).toEqual(spec);
});

it("keeps the full current revision population after rejected verification, including more than three saved questions", async () => {
  const x = await seed(), { content, spec, revision: previous } = await compile(x);
  const chunks = await createOpeningSourceChunksRepository(f.sql).listForSources(f.scope, [x.sourceId]);
  const outline = proposeTeachingOutline({ activityId: x.activity.id, intentKind: "material", intentSummary: "current revision",
    sourceIds: [x.sourceId], chunks, maxItems: 1 });
  // Exercise repository compatibility with larger saved/manual revisions, not a
  // relaxation of the production model compiler's two/three-check policy.
  const compiled = compileCurrentActivity({ outline, focusItemId: outline.focusItemId, teachingUnitId: spec.teachingUnitId,
    expectedContentVersion: 1, revisionNumber: spec.revisionNumber + 1,
    pack: assembleTeachingEvidencePack({ chunks, query: "evidence", maxCharacters: 4000 }),
    modelOutput: { itemTitles: [], blocks: [
      { type: "text", text: "source evidence", citedChunkIds: [x.chunkId] },
      ...Array.from({ length: 5 }, (_, index) => [
        { type: "prompt" as const, text: `修订题目${index}`, citedChunkIds: [] },
        { type: "answer_key" as const, text: `修订参考${index}`, citedChunkIds: [] },
      ]).flat(),
    ] } });
  const written = await content.writeUnitBlocks(f.scope, spec.teachingUnitId, compiled.libraryBlocks);
  const current = await content.publishActivitySpec(f.scope, { ...compiled.publishInput,
    revisionNumber: written.revisionNumber, verificationStatus: "rejected" });
  const revision = await content.readRevision(f.scope, current.documentId, current.revisionNumber);
  expect(revision.blocks).toHaveLength(11);
  expect(revision.blocks.filter(block => (block.content.citationBinding as { status: string }).status === "missing")).toHaveLength(10);
  const route = await x.repo.read(f.scope, x.courseId, x.activity.id);
  expect(route.requirements[0]).toMatchObject({ compilation: { saved: true, contentVersion: 2, verificationStatus: "rejected" },
    questionCoverage: { savedQuestions: 5, withReferenceAnswers: 5, issuedQuestions: 0 } });
  expect(await content.readRevision(f.scope, spec.documentId, spec.revisionNumber)).toEqual(previous);
});

it.each(["privacy", "version", "chunk", "membership", "withdrawn"])("does not advertise a usable route after %s invalidation", async kind => {
  const x = await seed(), { content, spec, revision } = await compile(x);
  if (kind === "privacy") await backupRows(f.sql, f.scope).exclude(x.sourceId);
  if (kind === "version") await f.sql`UPDATE opening_sources SET version=1 WHERE id=${x.sourceId}`;
  if (kind === "chunk") await f.sql`DELETE FROM opening_source_chunks WHERE id=${x.chunkId}`;
  if (kind === "membership") await f.sql`DELETE FROM course_asset_memberships WHERE course_id=${x.courseId} AND asset_id=${x.sourceId}`;
  if (kind === "withdrawn") await f.sql`UPDATE opening_sources SET upload_state='rejected' WHERE id=${x.sourceId}`;
  const route = await x.repo.read(f.scope, x.courseId, x.activity.id);
  expect(route.requirements[0]!.compilation?.saved).toBe(false);
  expect(route.requirements[0]!.sourcesAvailable).toBe(false);
  // Immutable historical bindings are not rewritten into current availability
  // assertions; live source validation remains mandatory for any consumer.
  expect(await content.readRevision(f.scope, spec.documentId, spec.revisionNumber)).toEqual(revision);
});
