import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createOpeningLearningGoalRepository, createOpeningBudgetRepository,
  createOpeningSourceChunksRepository, createOpeningPrivacyRepository,
  createOpeningTeachingContentRepository, createOpeningJobRepository,
} from "@aistudy/database";
import { createOpeningCourseRouteRepository } from "../../packages/database/src/repositories/opening-course-route";
import { createCompileTeachingUnitHandler } from "../../apps/worker/src/jobs/compile-teaching-unit";
import { createCompileTeachingUnitWorkerDeps } from "../../apps/worker/src/runtime/compile-teaching-unit-wiring";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { backupRows } from "./opening-backup-records-fixture";
import { rankPedagogy } from "../fixtures/opening/teaching/rank-pedagogy";

let f: OpeningFixture;
beforeEach(async () => {
  f = await createOpeningFixture();
  vi.stubEnv("OPENING_TEACHING_COMPILER_ENABLED", "1");
  vi.stubEnv("OPENING_TEACHING_VALIDATION_ENABLED", "1");
});
afterEach(async () => { vi.unstubAllEnvs(); await f?.close(); });

it.each([
  ["1 + 2 = 3 = 6/2", "pass"],
  ["1 + 2 = 4 = 3", "fail"],
  ["x + 1 = 2", "unknown"],
] as const)("real Worker publishes %s with tool_result %s and no verified authority", async (formula, outcome) => {
  const courseId = randomUUID(), requirementId = randomUUID();
  const rows = backupRows(f.sql, f.scope);
  const sourceId = await rows.source("uploaded", 1), chunkId = await rows.chunk(sourceId, 1);
  const sourceText = "秩与零空间维数之和等于列数。一个3×5矩阵的秩为2，零空间维数为5 − 2 = 3。再换一个列数验证。一个3×4矩阵的秩为2，零空间维数为4 − 2 = 2。";
  await f.sql`UPDATE opening_source_chunks SET image_object_key=NULL,text=${sourceText} WHERE id=${chunkId}`;
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${courseId},${f.scope.workspaceId},'Formula tool',${courseId})`;
  await f.sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,visibility) VALUES(${f.scope.workspaceId},${courseId},'source',${sourceId},'core','course')`;
  const goal = await createOpeningLearningGoalRepository(f.sql).create(f.scope, {
    clientKey: randomUUID(), courseIds: [courseId], title: "秩", kind: "custom", targetDate: null,
    examDate: null, weeklyMinutes: 120, priority: 1, learningMode: "understand", successCriteria: "独立解释",
  });
  const route = createOpeningCourseRouteRepository(f.sql, { compilerEnabled: true });
  await route.confirm(f.scope, courseId, { expectedRevisions: [], confirmScope: true, requirements: [{
    id: requirementId, stableSkillId: randomUUID(), knowledgeNodeId: null, requirementKey: "rank", title: "秩",
    position: 0, mandatory: true, goalIds: [goal.id], prerequisiteIds: [],
    sourceRefs: [{ sourceId, sourceVersion: 1, chunkId }], origin: "confirmed",
    verification: { kind: "rubric", status: "ready", exerciseKeys: ["rank"], rubric: "列数减秩", missingReasons: [] },
  }] });
  const started = await route.start(f.scope, courseId, {
    goalId: goal.id, expectedGoalRevision: 1, requirementId, expectedRequirementRevision: 1,
    clientKey: randomUUID(), minutes: 20,
  });
  if (started.kind !== "ready") throw new Error(JSON.stringify(started));
  const activity = started.activity;
  const deps = createCompileTeachingUnitWorkerDeps(f.sql, {
    budget: createOpeningBudgetRepository(f.sql), chunks: createOpeningSourceChunksRepository(f.sql),
    privacy: createOpeningPrivacyRepository(f.sql),
  });
  // Only external model output is controlled: provider input, publication and validation are production wiring.
  deps.callModel = async (_scope, _input, options) => {
    await options.beforeSend?.();
    return { text: JSON.stringify({ itemTitles: ["秩与零空间"], blocks: [
      { type: "text", text: "秩与零空间维数之和等于列数。", citedChunkIds: [chunkId] },
      { type: "formula", text: formula, citedChunkIds: [chunkId] },
      { type: "prompt", text: "一个3×5矩阵的秩为2，零空间维数是多少？" },
      { type: "answer_key", ...rankPedagogy, citedChunkIds: [chunkId], text: "5 − 2 = 3", hints: { direction: "先找列数。", concept: "秩与零空间维数之和等于列数。", firstStep: "用5减去2。" } },
      { type: "text", text: "再换一个列数验证。", citedChunkIds: [chunkId] },
      { type: "prompt", text: "一个3×4矩阵的秩为2，零空间维数是多少？" },
      { type: "answer_key", ...rankPedagogy, citedChunkIds: [chunkId], text: "4 − 2 = 2", hints: { direction: "先找列数。", concept: "秩与零空间维数之和等于列数。", firstStep: "用4减去2。" } },
    ] }), citedChunkIds: [], requestId: null, candidates: [], inputTokens: 10, outputTokens: 10 };
  };
  const [row] = await f.sql`SELECT id FROM opening_jobs WHERE workspace_id=${f.scope.workspaceId} AND kind='compile-teaching-unit' AND payload->>'activityId'=${activity.id}`;
  const job = await createOpeningJobRepository(f.sql).claim(String(row!.id));
  if (!job) throw new Error("compile job not claimable");
  const result = await createCompileTeachingUnitHandler(deps)(job, job.payload);
  expect(result).toMatchObject({
    generateStatus: "needs_check", verificationStatus: "needs_check",
    validationReport: { factPassed: false, presentation: { kind: "discussion_draft", allowsFormalScoring: false },
      layers: expect.arrayContaining([
        expect.objectContaining({ layer: "tool_result", outcome }),
        expect.objectContaining({ layer: "claim_support", outcome: "unknown" }),
      ]),
    },
  });
  const content = createOpeningTeachingContentRepository(f.sql);
  const spec = await content.getActivitySpec(f.scope, activity.id);
  expect(spec).toMatchObject({ verificationStatus: "needs_check" });
  const unit = await content.getUnit(f.scope, spec!.teachingUnitId);
  const revision = await content.readRevision(f.scope, unit!.documentId, spec!.revisionNumber);
  expect(revision.blocks.find(block => block.type === "formula")?.content).toMatchObject({ latex: formula });
  console.info("PG formula tool", JSON.stringify({ formula, outcome, verificationStatus: spec!.verificationStatus }));
});
