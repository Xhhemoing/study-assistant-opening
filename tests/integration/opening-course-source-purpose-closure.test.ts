import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createCourseMembershipRepository, createOpeningCourseReadySourcesRepository, createOpeningTeachingContentRepository } from "@aistudy/database";
import { createOpeningMaterialRetriever } from "../../apps/worker/src/runtime/material-retrieval";
import { createOpeningFixture, insertTestTeachingActivity, type OpeningFixture } from "./opening-fixture";
import { backupRows } from "./opening-backup-records-fixture";

let f: OpeningFixture;
beforeAll(async () => { f = await createOpeningFixture(); });
afterAll(async () => { await f?.close(); });

async function setup() {
  const courses = createCourseMembershipRepository(f.sql), rows = backupRows(f.sql, f.scope);
  const sourceId = await rows.source("uploaded", 1), chunkId = await rows.chunk(sourceId);
  const course = await courses.createCourse({ workspaceId: f.scope.workspaceId, title: "303 synthetic course", slug: randomUUID() });
  const other = await courses.createCourse({ workspaceId: f.scope.workspaceId, title: "303 independent course", slug: randomUUID() });
  const input = { workspaceId: f.scope.workspaceId, courseId: course.id, assetType: "source" as const, assetId: sourceId };
  const membership = await courses.addAssetMembership({ ...input, purpose: "teaching", role: "core", visibility: "private" });
  const otherMembership = await courses.addAssetMembership({ ...input, courseId: other.id, purpose: "teaching", role: "core", visibility: "private" });
  const chunk = { id: chunkId, sourceId, sourceVersion: 1, page: 1, text: "source evidence", startMs: null, endMs: null, imageObjectKey: "private/locator" };
  const retrieve = createOpeningMaterialRetriever(f.sql, {} as never, null);
  const query = { sourceIds: [sourceId], chunks: [chunk], query: "source evidence", maxCharacters: 1000, operationId: randomUUID(),
    courseContext: { courseId: course.id, materialUse: "teaching" as const } };
  return { courses, sourceId, chunkId, course, other, input, membership, otherMembership, retrieve, query };
}

it("303: course-local retrieval and final generation survive a different course purpose revision", async () => {
  const x = await setup(), result = await x.retrieve(f.scope, x.query);
  expect(result.chunks.map(chunk => chunk.id)).toEqual([x.chunkId]);
  const activityId = await insertTestTeachingActivity(f.sql, f.scope, x.course.id);
  await f.sql`UPDATE opening_teaching_activities SET source_ids=ARRAY[${x.sourceId}]::uuid[] WHERE id=${activityId}`;
  const purposes = createOpeningCourseReadySourcesRepository(f.sql);
  const pin = await purposes.readSourcePurposePin(f.scope, { activityId });
  const content = createOpeningTeachingContentRepository(f.sql);
  const unit = await content.createUnit(f.scope, { title: "303 draft", blocks: [{ id: randomUUID(), type: "meta", content: { text: "draft" } }] });
  const block = { id: randomUUID(), type: "text", content: { text: "303 compiled body" } };
  await x.courses.updateAssetMembership({ ...x.input, courseId: x.other.id, purpose: "mock_exam", expectedUpdatedAt: x.otherMembership.updatedAt.toISOString() });
  await expect(result.assertCurrent()).resolves.toBeUndefined();
  await expect(x.retrieve(f.scope, { ...x.query, courseContext: { courseId: x.other.id, materialUse: "teaching" } })).rejects.toMatchObject({ code: "CONFLICT" });
  await content.publishCompiledActivity(f.scope, { activityId, teachingUnitId: unit.id, expectedVersion: 0, revisionNumber: 2,
    blockOrder: [{ blockId: block.id, blockType: "text", position: 0, role: "teach" }], sourceRefs: [{ sourceId: x.sourceId, version: 1 }], verificationStatus: "needs_check" },
    { blocks: [block], expectedDocumentRevision: 1, revisionId: randomUUID() }, tx => purposes.assertSourcePurposePin(f.scope, pin, tx));
  expect((await content.readRevision(f.scope, unit.documentId, 2)).blocks).toEqual([{ ...block, position: 0 }]);
  expect(await content.getActivitySpec(f.scope, activityId)).toMatchObject({ version: 1, revisionNumber: 2 });
});

it("303: source revision change between selection and final generation leaves the old body and activity untouched", async () => {
  const x = await setup(), activityId = await insertTestTeachingActivity(f.sql, f.scope, x.course.id);
  await f.sql`UPDATE opening_teaching_activities SET source_ids=ARRAY[${x.sourceId}]::uuid[] WHERE id=${activityId}`;
  const purposes = createOpeningCourseReadySourcesRepository(f.sql);
  const pin = await purposes.readSourcePurposePin(f.scope, { activityId });
  const content = createOpeningTeachingContentRepository(f.sql);
  const unit = await content.createUnit(f.scope, { title: "303 unchanged draft", blocks: [{ id: randomUUID(), type: "meta", content: { text: "old draft" } }] });
  const before = await content.readRevision(f.scope, unit.documentId, 1);
  const activityBefore = await f.sql`SELECT * FROM opening_teaching_activities WHERE id=${activityId}`;
  const block = { id: randomUUID(), type: "text", content: { text: "must not publish stale generation" } };
  const revisionId = randomUUID();
  await f.sql`UPDATE opening_sources SET version=version+1 WHERE id=${x.sourceId}`;
  await expect(content.publishCompiledActivity(f.scope, { activityId, teachingUnitId: unit.id, expectedVersion: 0, revisionNumber: 2,
    blockOrder: [{ blockId: block.id, blockType: "text", position: 0, role: "teach" }], sourceRefs: [{ sourceId: x.sourceId, version: 1 }], verificationStatus: "needs_check" },
    { blocks: [block], expectedDocumentRevision: 1, revisionId }, tx => purposes.assertSourcePurposePin(f.scope, pin, tx)))
    .rejects.toMatchObject({ code: "CONFLICT" });
  expect(await content.readRevision(f.scope, unit.documentId, 1)).toEqual(before);
  expect(await f.sql`SELECT * FROM opening_teaching_activities WHERE id=${activityId}`).toEqual(activityBefore);
  expect(await f.sql`SELECT id FROM library_revisions WHERE id=${revisionId}`).toHaveLength(0);
  expect(await f.sql`SELECT id FROM library_blocks WHERE document_id=${unit.documentId} AND id=${block.id}`).toHaveLength(0);
  expect(await content.getActivitySpec(f.scope, activityId)).toBeNull();
});

it("303: rejects a mixed explicit allowed/forbidden selection instead of returning partial lexical success", async () => {
  const x = await setup(), rows = backupRows(f.sql, f.scope);
  const forbidden = await rows.source(), chunkId = await rows.chunk(forbidden);
  await x.courses.addAssetMembership({ ...x.input, assetId: forbidden, purpose: "mock_exam", role: "core", visibility: "private" });
  await expect(x.retrieve(f.scope, { ...x.query, sourceIds: [x.sourceId, forbidden], chunks: [...x.query.chunks,
    { ...x.query.chunks[0]!, id: chunkId, sourceId: forbidden }] })).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(x.retrieve(f.scope, x.query)).resolves.toMatchObject({ chunks: [{ id: x.chunkId }] });
});

it("303: selected source ids do not authorize chunks from an unselected forbidden source", async () => {
  const x = await setup(), rows = backupRows(f.sql, f.scope);
  const forbidden = await rows.source(), chunkId = await rows.chunk(forbidden);
  await x.courses.addAssetMembership({ ...x.input, assetId: forbidden, purpose: "mock_exam", role: "core", visibility: "private" });
  const result = await x.retrieve(f.scope, { ...x.query, chunks: [...x.query.chunks, { ...x.query.chunks[0]!, id: chunkId, sourceId: forbidden }] });
  expect(result.chunks.map(chunk => chunk.id)).toEqual([x.chunkId]);
  expect(result.purposePin?.sources.map(source => source.sourceId)).toEqual([x.sourceId]);
});

it.each(["version", "privacy", "parse", "archive"] as const)("303: captured retrieval fails closed after %s changes, without recapturing authority", async changed => {
  const x = await setup(), result = await x.retrieve(f.scope, x.query);
  expect(result.purposePin?.sources[0]?.sourceVersion).toBe(1);
  if (changed === "version") await f.sql`UPDATE opening_sources SET version=version+1 WHERE id=${x.sourceId}`;
  if (changed === "privacy") await backupRows(f.sql, f.scope).exclude(x.sourceId);
  if (changed === "parse") await f.sql`UPDATE opening_sources SET parse_state='failed' WHERE id=${x.sourceId}`;
  if (changed === "archive") await f.sql`UPDATE courses SET archived_at=now() WHERE id=${x.course.id}`;
  await expect(result.assertCurrent()).rejects.toMatchObject({ code: "CONFLICT" });
  expect(result.purposePin?.sources[0]?.sourceVersion).toBe(1);
});

it("303: standalone captured retrieval is invalidated by classification on a different course", async () => {
  const x = await setup();
  // Remove both course classifications first: null is explicit standalone use, not a guessed course.
  for (const courseId of [x.course.id, x.other.id]) {
    const current = await x.courses.getMembership({ ...x.input, courseId });
    await x.courses.updateAssetMembership({ ...x.input, courseId, purpose: null, expectedUpdatedAt: current.updatedAt.toISOString() });
  }
  const result = await x.retrieve(f.scope, { ...x.query, courseContext: { courseId: null, materialUse: "citation" } });
  await expect(result.assertCurrent()).resolves.toBeUndefined();
  const current = await x.courses.getMembership({ ...x.input, courseId: x.other.id });
  await x.courses.updateAssetMembership({ ...x.input, courseId: x.other.id, purpose: "reference", expectedUpdatedAt: current.updatedAt.toISOString() });
  await expect(result.assertCurrent()).rejects.toMatchObject({ code: "CONFLICT" });
});

it("303: real SQL NOWAIT propagates 55P03 while the final material pin owns source row locks", async () => {
  const x = await setup(), purposes = createOpeningCourseReadySourcesRepository(f.sql);
  const pin = await purposes.readMaterialPurposePin(f.scope, { courseId: x.course.id, sourceIds: [x.sourceId], materialUse: "teaching" });
  await f.sql.begin(async tx => {
    await purposes.assertMaterialPurposePin(f.scope, pin, tx);
    await expect(f.sql.begin(async other => {
      await other`SELECT id FROM opening_sources WHERE id=${x.sourceId} FOR UPDATE NOWAIT`;
    })).rejects.toMatchObject({ code: "55P03" });
  });
  await expect(resultAfterCommit()).resolves.toHaveLength(1);
  async function resultAfterCommit() {
    return f.sql.begin(other => other`SELECT id FROM opening_sources WHERE id=${x.sourceId} FOR UPDATE NOWAIT`);
  }
});
