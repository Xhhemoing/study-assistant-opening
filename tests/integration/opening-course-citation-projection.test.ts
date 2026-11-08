import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { assembleTeachingEvidencePack, compileCurrentActivity, proposeTeachingOutline } from "@aistudy/ai";
import { createOpeningSourceChunksRepository,
  createOpeningTeachingContentRepository, createOpeningLearningGoalRepository } from "@aistudy/database";
import { courseRouteSnapshotSchema } from "@aistudy/contracts";
import { createOpeningCourseRouteRepository } from "../../packages/database/src/repositories/opening-course-route";
import { projectCourseCitationCoverage } from "../../packages/domain/src/opening/course-citation-coverage";
import { backupRows } from "./opening-backup-records-fixture";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

async function seedRoute(sourceId: string, chunkId: string) {
  const courseId = randomUUID(), requirementId = randomUUID();
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${courseId},${f.scope.workspaceId},'Projection route',${courseId})`;
  await f.sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,visibility)
    VALUES(${f.scope.workspaceId},${courseId},'source',${sourceId},'core','course')`;
  const goal = await createOpeningLearningGoalRepository(f.sql).create(f.scope, { clientKey: randomUUID(), courseIds: [courseId],
    title: "Coverage", kind: "custom", targetDate: null, examDate: null, weeklyMinutes: 120, priority: 1,
    learningMode: "understand", successCriteria: "Count all roles" });
  const repo = createOpeningCourseRouteRepository(f.sql, { compilerEnabled: true });
  await repo.confirm(f.scope, courseId, { expectedRevisions: [], confirmScope: true, requirements: [{
    id: requirementId, stableSkillId: randomUUID(), knowledgeNodeId: null, requirementKey: "coverage", title: "Coverage",
    position: 0, mandatory: true, goalIds: [goal.id], prerequisiteIds: [], sourceRefs: [{ sourceId, sourceVersion: 0, chunkId }],
    verification: { kind: "unavailable", status: "missing", exerciseKeys: [], rubric: null, missingReasons: [] }, origin: "confirmed",
  }] });
  expect((await repo.read(f.scope, courseId)).requirements[0]!.citationCoverage).toBeUndefined();
  const started = await repo.start(f.scope, courseId, { goalId: goal.id, expectedGoalRevision: 1,
    requirementId, expectedRequirementRevision: 1, clientKey: randomUUID(), minutes: 20 });
  if (started.kind !== "ready") throw new Error(started.reason);
  return { activity: started.activity, repo, courseId, requirementId };
}

let f: OpeningFixture;
beforeEach(async () => { f = await createOpeningFixture(); });
afterEach(async () => { await f?.close(); });

it("projects every persisted block in the pinned current rejected revision, without exposing hidden keys", async () => {
  const rows = backupRows(f.sql, f.scope);
  const sourceId = await rows.source("uploaded", 0), chunkId = await rows.chunk(sourceId, 0);
  await f.sql`UPDATE opening_source_chunks SET image_object_key=NULL WHERE id=${chunkId}`;
  const { activity, repo, courseId } = await seedRoute(sourceId, chunkId);
  const content = createOpeningTeachingContentRepository(f.sql);
  const unit = await content.createUnit(f.scope, { title: "Coverage fixture",
    blocks: [{ id: randomUUID(), type: "text", content: { text: "Initial body" } }] });
  const initial = await content.readRevision(f.scope, unit.documentId, unit.currentRevisionNumber);
  await content.publishActivitySpec(f.scope, { activityId: activity.id, teachingUnitId: unit.id, expectedVersion: 0,
    revisionNumber: unit.currentRevisionNumber, sourceRefs: [{ sourceId, version: 0, chunkId }],
    blockOrder: [{ blockId: initial.blocks[0]!.id, blockType: "text", role: "teach", position: 0 }] });
  expect((await repo.read(f.scope, courseId)).requirements[0]!.citationCoverage).toMatchObject({ total: 1, unknown: 1 });
  const chunks = await createOpeningSourceChunksRepository(f.sql).listForSources(f.scope, [sourceId]);
  const outline = proposeTeachingOutline({ activityId: activity.id, intentKind: "topic", intentSummary: "coverage",
    sourceIds: [sourceId], chunks, maxItems: 1 });
  const compiled = compileCurrentActivity({ outline, focusItemId: outline.focusItemId, teachingUnitId: unit.id,
    expectedContentVersion: 1, revisionNumber: 2,
    pack: assembleTeachingEvidencePack({ chunks, query: "evidence", maxCharacters: 4000 }),
    modelOutput: { itemTitles: [], blocks: [
      { type: "text", text: "source evidence", citedChunkIds: [chunkId] },
      { type: "formula", text: "x = 0", citedChunkIds: [] },
      { type: "example", text: "source evidence", citedChunkIds: [randomUUID()] },
      ...Array.from({ length: 5 }, (_, n) => [
        { type: "prompt" as const, text: `private-prompt-${n}`, citedChunkIds: n === 0 ? [chunkId] : [] },
        { type: "answer_key" as const, text: `private-solution-${n}`, citedChunkIds: n === 0 ? [chunkId] : [] },
      ]).flat(),
    ] } });
  const written = await content.writeUnitBlocks(f.scope, unit.id, compiled.libraryBlocks);
  await content.publishActivitySpec(f.scope, { ...compiled.publishInput, revisionNumber: written.revisionNumber,
    verificationStatus: "rejected" });
  // Unpublished latest body must not replace the pinned current spec's population.
  await content.writeUnitBlocks(f.scope, unit.id, [{ id: randomUUID(), type: "text", content: { text: "unpublished" } }]);
  const spec = await content.getActivitySpec(f.scope, activity.id);
  expect(spec?.verificationStatus).toBe("rejected");
  const revision = await content.readRevision(f.scope, spec!.documentId, spec!.revisionNumber);
  const coverage = projectCourseCitationCoverage({ blockOrder: spec!.blockOrder, blocks: revision.blocks });
  expect(coverage).toEqual({ total: 13, bound: 3, missing: 9, mismatch: 1, unknown: 0, factualSupport: "unverified",
    byRole: {
      teach: { total: 2, bound: 1, missing: 1, mismatch: 0, unknown: 0 },
      example: { total: 1, bound: 0, missing: 0, mismatch: 1, unknown: 0 },
      prompt: { total: 5, bound: 1, missing: 4, mismatch: 0, unknown: 0 },
      answer_key: { total: 5, bound: 1, missing: 4, mismatch: 0, unknown: 0 },
    } });
  const client = await content.getClientInit(f.scope, activity.id);
  expect(client!.blocks.filter(block => block.role === "answer_key").every(block => block.content === null)).toBe(true);
  const serialized = JSON.stringify(coverage);
  for (const secret of ["private-prompt", "private-solution", sourceId, chunkId, "refs", "blockId"])
    expect(serialized).not.toContain(secret);
  // Scope remains the real reader's responsibility, not projection's.
  await expect(content.getActivitySpec(f.otherScope, activity.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(content.readRevision(f.otherScope, spec!.documentId, spec!.revisionNumber)).rejects.toBeDefined();
  const route = courseRouteSnapshotSchema.parse(await repo.read(f.scope, courseId));
  expect(route.requirements[0]!.citationCoverage).toEqual(coverage);
  expect(route.requirements[0]!.compilation).toMatchObject({ verificationStatus: "rejected", saved: true });
  expect(JSON.stringify(route.requirements[0]!.citationCoverage)).not.toContain("private-");
  await expect(repo.read(f.otherScope, courseId)).rejects.toMatchObject({ code: "NOT_FOUND" });
});

it.each(["privacy", "version", "chunk", "membership", "withdrawn", "versionAvailability", "requirement", "specVersion", "incompleteGraph", "newerUnpublishedActivity", "foreignBinding", "emptyGraph"])(
  "does not resurrect historical coverage after %s invalidation", async kind => {
    const rows = backupRows(f.sql, f.scope), sourceId = await rows.source("uploaded", 0), chunkId = await rows.chunk(sourceId, 0);
    const x = await seedRoute(sourceId, chunkId), content = createOpeningTeachingContentRepository(f.sql);
    const blockId = randomUUID(), unit = await content.createUnit(f.scope, { title: "Revocable", blocks: [{ id: blockId, type: "text",
      content: { text: "private-body", citationBinding: { blockId, role: "teach", status: "bound", factualSupport: "unverified",
        refs: [{ sourceId, sourceVersion: 0, chunkId, page: 1 }] } } }] });
    await content.publishActivitySpec(f.scope, { activityId: x.activity.id, teachingUnitId: unit.id, expectedVersion: 0,
      revisionNumber: unit.currentRevisionNumber, blockOrder: [{ blockId, blockType: "text", role: "teach", position: 0 }],
      sourceRefs: [{ sourceId, version: 0, chunkId, page: 1 }] });
    expect((await x.repo.read(f.scope, x.courseId)).requirements[0]!.citationCoverage).toMatchObject({ total: 1, bound: 1 });
    if (kind === "privacy") await rows.exclude(sourceId);
    if (kind === "version") await f.sql`UPDATE opening_sources SET version=1 WHERE id=${sourceId}`;
    if (kind === "chunk") await f.sql`DELETE FROM opening_source_chunks WHERE id=${chunkId}`;
    if (kind === "membership") await f.sql`DELETE FROM course_asset_memberships WHERE course_id=${x.courseId} AND asset_id=${sourceId}`;
    if (kind === "withdrawn") await f.sql`UPDATE opening_sources SET upload_state='rejected' WHERE id=${sourceId}`;
    if (kind === "versionAvailability") await f.sql`INSERT INTO opening_source_versions(source_id,version,workspace_id,availability)
      VALUES(${sourceId},0,${f.scope.workspaceId},'unavailable') ON CONFLICT(source_id,version) DO UPDATE SET availability='unavailable'`;
    if (kind === "requirement") await f.sql`UPDATE course_requirements SET revision=revision+1 WHERE id=${x.requirementId}`;
    if (kind === "specVersion") await f.sql`UPDATE opening_teaching_activity_specs SET version=version+1 WHERE activity_id=${x.activity.id}`;
    if (kind === "incompleteGraph") await f.sql`UPDATE opening_teaching_activity_specs SET block_order=${f.sql.json([
      { blockId: randomUUID(), blockType: "prompt", role: "prompt", position: 0 }])} WHERE activity_id=${x.activity.id}`;
    if (kind === "emptyGraph") await f.sql`UPDATE opening_teaching_activity_specs SET block_order='[]'::jsonb WHERE activity_id=${x.activity.id}`;
    if (kind === "foreignBinding") {
      const foreignRows = backupRows(f.sql, f.otherScope), foreignId = await foreignRows.source("uploaded", 0), foreignChunk = await foreignRows.chunk(foreignId, 0);
      const written = await content.writeUnitBlocks(f.scope, unit.id, [{ id: blockId, type: "text", content: { text: "private-body",
        citationBinding: { blockId, role: "teach", status: "bound", factualSupport: "unverified",
          refs: [{ sourceId: foreignId, sourceVersion: 0, chunkId: foreignChunk, page: 1 }] } } }]);
      await content.publishActivitySpec(f.scope, { activityId: x.activity.id, teachingUnitId: unit.id, expectedVersion: 1,
        revisionNumber: written.revisionNumber, blockOrder: [{ blockId, blockType: "text", role: "teach", position: 0 }],
        sourceRefs: [{ sourceId, version: 0, chunkId, page: 1 }] });
    }
    if (kind === "newerUnpublishedActivity") await f.sql`INSERT INTO opening_teaching_activities
      (id,workspace_id,owner_user_id,course_id,status,intent_kind,intent_summary,client_key,create_intent,source_ids,goal_json,updated_at)
      SELECT ${randomUUID()},workspace_id,owner_user_id,course_id,'active',intent_kind,intent_summary,${randomUUID()},'{}'::jsonb,source_ids,goal_json,now()+interval '1 second'
      FROM opening_teaching_activities WHERE id=${x.activity.id}`;
    const result = courseRouteSnapshotSchema.parse(await x.repo.read(f.scope, x.courseId)).requirements[0]!;
    expect(result.citationCoverage).toBeUndefined();
    expect(result.missingReasons.some(reason => reason.startsWith("引用覆盖未知："))).toBe(true);
  });

it("keeps persisted legacy, malformed and copied-identity bindings unknown", async () => {
  const rows = backupRows(f.sql, f.scope), sourceId = await rows.source("uploaded", 0), chunkId = await rows.chunk(sourceId, 0);
  const { activity, repo, courseId } = await seedRoute(sourceId, chunkId);
  const content = createOpeningTeachingContentRepository(f.sql);
  const blocks = [
    { id: randomUUID(), type: "text", content: { text: "legacy", citedChunkIds: [randomUUID()] } },
    { id: randomUUID(), type: "prompt", content: { text: "private-question", citationBinding: { status: "bound" } } },
    { id: randomUUID(), type: "answer_key", content: { answer: "private-key", citationBinding: {
      blockId: randomUUID(), role: "answer_key", status: "missing", refs: [], factualSupport: "unverified" } } },
  ];
  const unit = await content.createUnit(f.scope, { title: "Legacy", blocks });
  const blockOrder = blocks.map((block, position) => ({ blockId: block.id, blockType: block.type, position,
    role: position === 0 ? "teach" as const : position === 1 ? "prompt" as const : "answer_key" as const }));
  await content.publishActivitySpec(f.scope, { activityId: activity.id, teachingUnitId: unit.id, expectedVersion: 0,
    revisionNumber: unit.currentRevisionNumber, blockOrder, sourceRefs: [{ sourceId, version: 0, chunkId }] });
  const spec = await content.getActivitySpec(f.scope, activity.id);
  const revision = await content.readRevision(f.scope, spec!.documentId, spec!.revisionNumber);
  expect(projectCourseCitationCoverage({ blockOrder: spec!.blockOrder, blocks: revision.blocks }))
    .toMatchObject({ total: 3, bound: 0, missing: 0, mismatch: 0, unknown: 3, factualSupport: "unverified" });
  const result = courseRouteSnapshotSchema.parse(await repo.read(f.scope, courseId)).requirements[0]!;
  expect(result.citationCoverage).toMatchObject({ total: 3, bound: 0, unknown: 3 });
  expect(result.missingReasons).toContain("引用覆盖未知：部分历史绑定缺失或无效");
});
