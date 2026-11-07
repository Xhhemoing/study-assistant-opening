import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { courseRouteSnapshotSchema, type CourseRouteRequirementInput, type TeachingActivity } from "@aistudy/contracts";
import { createOpeningLearningGoalRepository, createOpeningBudgetRepository, createOpeningSourceChunksRepository, createOpeningPrivacyRepository, createOpeningTeachingContentRepository, createOpeningJobRepository } from "@aistudy/database";
import { createOpeningCourseRouteRepository } from "../../packages/database/src/repositories/opening-course-route";
import { createCompileTeachingUnitHandler } from "../../apps/worker/src/jobs/compile-teaching-unit";
import { createCompileTeachingUnitWorkerDeps } from "../../apps/worker/src/runtime/compile-teaching-unit-wiring";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { backupRows } from "./opening-backup-records-fixture";
import { rankPedagogy } from "../fixtures/opening/teaching/rank-pedagogy";
let f: OpeningFixture;
beforeEach(async () => { f = await createOpeningFixture(); vi.stubEnv("OPENING_TEACHING_COMPILER_ENABLED", "1"); vi.stubEnv("OPENING_TEACHING_VALIDATION_ENABLED", "0"); });
afterEach(async () => { vi.unstubAllEnvs(); await f?.close(); });
async function seed() {
  const courseId = randomUUID(), rows = backupRows(f.sql, f.scope), sourceId = await rows.source("uploaded", 1), chunkId = await rows.chunk(sourceId, 1);
  await f.sql`UPDATE opening_source_chunks SET image_object_key=NULL,text='秩与零空间维数之和等于列数。' WHERE id=${chunkId}`;
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${courseId},${f.scope.workspaceId},'Compilation gaps',${courseId})`;
  await f.sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,visibility) VALUES(${f.scope.workspaceId},${courseId},'source',${sourceId},'core','course')`;
  const goal = await createOpeningLearningGoalRepository(f.sql).create(f.scope, { clientKey: randomUUID(), courseIds: [courseId], title: "全课", kind: "custom", targetDate: null, examDate: null, weeklyMinutes: 120, priority: 1, learningMode: "understand", successCriteria: "独立解释" });
  const requirements: CourseRouteRequirementInput[] = Array.from({ length: 3 }, (_, position) => ({ id: randomUUID(), stableSkillId: randomUUID(), knowledgeNodeId: null, requirementKey: `rank:${position}`, title: `秩${position}`, position, mandatory: true, goalIds: [goal.id], prerequisiteIds: [], sourceRefs: [{ sourceId, sourceVersion: 1, chunkId }], verification: { kind: "rubric", status: "ready", exerciseKeys: ["rank"], rubric: "列数减秩", missingReasons: [] }, origin: "confirmed" }));
  const repo = createOpeningCourseRouteRepository(f.sql, { compilerEnabled: true });
  await repo.confirm(f.scope, courseId, { expectedRevisions: [], requirements, confirmScope: true });
  // Ready is a server-side fixture fact, never trusted from a confirmation request.
  for (const requirement of requirements) await f.sql`UPDATE course_requirements SET verification=${f.sql.json(requirement.verification)} WHERE id=${requirement.id} AND workspace_id=${f.scope.workspaceId} AND owner_user_id=${f.scope.ownerUserId}`;
  async function start(index: number) {
    const result = await repo.start(f.scope, courseId, { goalId: goal.id, expectedGoalRevision: 1, requirementId: requirements[index]!.id, expectedRequirementRevision: 1, clientKey: randomUUID(), minutes: 20 });
    if (result.kind !== "ready") throw new Error(JSON.stringify(result));
    return result.activity;
  }
  return { repo, courseId, sourceId, requirements, start };
}
async function compile(activity: TeachingActivity) {
  const deps = createCompileTeachingUnitWorkerDeps(f.sql, { budget: createOpeningBudgetRepository(f.sql), chunks: createOpeningSourceChunksRepository(f.sql), privacy: createOpeningPrivacyRepository(f.sql) });
  // The production builder, library writer and publisher all run; only the external model is controlled.
  deps.callModel = async (_scope, input, options) => {
    await options.beforeSend?.();
    expect(input.chunks.length).toBeGreaterThan(0);
    return { text: JSON.stringify({ itemTitles: ["秩与零空间"], blocks: [
      { type: "text", text: "秩与零空间维数之和等于列数。", citedChunkIds: input.chunks.map(chunk => chunk.id) },
      { type: "prompt", text: "一个3×5矩阵的秩为2，零空间维数是多少？" },
      { type: "answer_key", ...rankPedagogy, text: "5 − 2 = 3", hints: { direction: "先找列数。", concept: "秩与零空间维数之和等于列数。", firstStep: "用5减去2。" } },
      { type: "text", text: "再换一个列数验证。" },
      { type: "prompt", text: "一个3×4矩阵的秩为2，零空间维数是多少？" },
      { type: "answer_key", ...rankPedagogy, text: "4 − 2 = 2", hints: { direction: "先找列数。", concept: "秩与零空间维数之和等于列数。", firstStep: "用4减去2。" } },
    ] }), citedChunkIds: [], requestId: null, candidates: [], inputTokens: 10, outputTokens: 10 };
  };
  const [row] = await f.sql`SELECT id FROM opening_jobs WHERE workspace_id=${f.scope.workspaceId} AND kind='compile-teaching-unit' AND payload->>'activityId'=${activity.id}`;
  const job = await createOpeningJobRepository(f.sql).claim(String(row!.id));
  if (!job) throw new Error("compile job not claimable");
  await createCompileTeachingUnitHandler(deps)(job, job.payload);
  const spec = await createOpeningTeachingContentRepository(f.sql).getActivitySpec(f.scope, activity.id);
  expect(spec).toMatchObject({ version: 1, verificationStatus: "needs_check" });
  return spec!;
}
async function counts() {
  const [row] = await f.sql`SELECT
    (SELECT count(*) FROM opening_teaching_activities WHERE workspace_id=${f.scope.workspaceId}) AS activities,
    (SELECT count(*) FROM opening_jobs WHERE workspace_id=${f.scope.workspaceId}) AS jobs,
    (SELECT count(*) FROM opening_budget_reservations WHERE workspace_id=${f.scope.workspaceId}) AS budgets`;
  return row;
}
it("projects all three requirements through the real compiler and strict snapshot without read side effects", async () => {
  const x = await seed(), first = await x.start(0), spec = await compile(first), queued = await x.start(1), before = await counts();
  const snapshot = courseRouteSnapshotSchema.parse(await x.repo.read(f.scope, x.courseId));
  expect(snapshot.summary).toEqual({ total: 3, mandatory: 3, verified: 0, blocked: 0 });
  expect(snapshot.requirements.map(row => row.compilation)).toEqual([
    { activityId: first.id, generateStatus: "needs_check", contentVersion: 1, saved: true, documentId: spec.documentId, revisionNumber: spec.revisionNumber, verificationStatus: "needs_check" },
    { activityId: queued.id, generateStatus: "queued", contentVersion: 0, saved: false, documentId: null, revisionNumber: null, verificationStatus: null },
    { activityId: null, generateStatus: null, contentVersion: 0, saved: false, documentId: null, revisionNumber: null, verificationStatus: null },
  ]);
  expect(await counts()).toEqual(before);
  console.info("PG compilation readback", JSON.stringify(snapshot.requirements.map(row => row.compilation)), "counts", before);
  await expect(x.repo.read(f.otherScope, x.courseId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  await f.sql`UPDATE opening_teaching_activities SET content_version=8 WHERE id=${queued.id}`;
  expect(courseRouteSnapshotSchema.parse(await x.repo.read(f.scope, x.courseId)).requirements[1]!.compilation).toMatchObject({ saved: false, generateStatus: "queued", contentVersion: 8 });
  await f.sql`UPDATE opening_teaching_activity_specs SET block_order='[]'::jsonb WHERE activity_id=${first.id}`;
  expect(courseRouteSnapshotSchema.parse(await x.repo.read(f.scope, x.courseId)).requirements[0]!.compilation?.saved).toBe(false);
});
it("rejects old requirement revisions, source versions and cancelled activities as current saved output", async () => {
  const x = await seed(), first = await x.start(0); await compile(first);
  await f.sql`UPDATE course_requirements SET revision=revision+1 WHERE id=${x.requirements[0]!.id}`;
  expect(courseRouteSnapshotSchema.parse(await x.repo.read(f.scope, x.courseId)).requirements[0]!.compilation).toMatchObject({ activityId: null, saved: false });
  await f.sql`UPDATE course_requirements SET revision=1 WHERE id=${x.requirements[0]!.id}`;
  await f.sql`UPDATE opening_sources SET version=2 WHERE id=${x.sourceId}`;
  expect(courseRouteSnapshotSchema.parse(await x.repo.read(f.scope, x.courseId)).requirements[0]!.compilation).toMatchObject({ activityId: first.id, saved: false, documentId: null });
  await f.sql`UPDATE opening_sources SET version=1 WHERE id=${x.sourceId}`;
  expect(courseRouteSnapshotSchema.parse(await x.repo.read(f.scope, x.courseId)).requirements[0]!.compilation?.saved).toBe(true);
  await f.sql`UPDATE opening_teaching_activities SET generate_status='cancelled' WHERE id=${first.id}`;
  expect(courseRouteSnapshotSchema.parse(await x.repo.read(f.scope, x.courseId)).requirements[0]!.compilation).toMatchObject({ activityId: null, saved: false });
});
