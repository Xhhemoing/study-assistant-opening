import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createOpeningJobRepository, createOpeningKnowledgeRepository } from "@aistudy/database";
import { createBuildCourseKnowledgeHandler } from "../../apps/worker/src/jobs/build-course-knowledge";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { backupRows } from "./opening-backup-records-fixture";

let fixture: OpeningFixture;
beforeEach(async () => { fixture = await createOpeningFixture(); });
afterEach(async () => { await fixture?.close(); });

async function material(courseId: string, text: string, version: number, page: number) {
  const { sql, scope } = fixture;
  const sourceId = await backupRows(sql, scope).source("uploaded", version);
  const chunkId = randomUUID();
  await sql`INSERT INTO opening_source_versions(source_id,version,workspace_id,bytes,sha256,availability)
    SELECT id,version,workspace_id,bytes,sha256,'available' FROM opening_sources WHERE id=${sourceId}`;
  await sql`INSERT INTO opening_source_chunks(id,source_id,source_version,page,text)
    VALUES(${chunkId},${sourceId},${version},${page},${text})`;
  await sql`INSERT INTO course_asset_memberships(id,workspace_id,course_id,asset_type,asset_id,role,visibility)
    VALUES(${randomUUID()},${scope.workspaceId},${courseId},'source',${sourceId},'core','course')`;
  return { sourceId, chunkId, version, page };
}

async function rebuild(courseId: string) {
  const { sql, scope } = fixture;
  const knowledge = createOpeningKnowledgeRepository(sql);
  const enqueued = await knowledge.enqueueRebuild(scope, courseId, { clientKey: randomUUID() });
  const job = await createOpeningJobRepository(sql).claim(enqueued.jobId);
  if (!job) throw new Error("Expected claimed real rebuild job");
  const handler = createBuildCourseKnowledgeHandler({
    listAuthorizedChunks: (owner, course) => knowledge.listAuthorizedChunks(owner, course),
    listReferencedNodeIds: (owner, course) => knowledge.listReferencedNodeIds(owner, course),
    get: (owner, course) => knowledge.getForRebuild(owner, course),
    replace: (owner, course, input) => knowledge.replace(owner, course, input),
    // Only extraction is controlled; batching, merge, identity, CAS and readback are real.
    extractGraph: async chunks => ({
      nodes: chunks.map(chunk => ({ label: "向量的定义", kind: "concept" as const,
        evidenceChunkIds: [chunk.id], status: "supported" as const })),
      edges: [],
    }),
  });
  await handler(job, job.payload);
  const result = await knowledge.get(scope, courseId);
  if (!result) throw new Error("Expected durable course knowledge");
  return result;
}

it("persists one exact definition with both source/version/page references and keeps conflicting text separate", async () => {
  const { sql, scope } = fixture, courseId = randomUUID();
  await sql`INSERT INTO courses(id,workspace_id,title,slug)
    VALUES(${courseId},${scope.workspaceId},'Multi-source course',${courseId})`;
  const a = await material(courseId, "cafe\u0301\r\nx² + x₁", 1, 2);
  const b = await material(courseId, "café\nx² + x₁", 7, 42);
  const conflict = await material(courseId, "café\nx2 + x₁", 3, 5);
  const saved = await rebuild(courseId);
  expect(saved.version).toBe(1);
  expect(saved.snapshot.nodes).toHaveLength(2);
  const merged = saved.snapshot.nodes.find(node => node.evidenceChunkIds.includes(a.chunkId));
  expect(merged?.evidenceChunkIds.slice().sort()).toEqual([a.chunkId, b.chunkId].sort());
  expect(saved.snapshot.nodes.find(node => node.evidenceChunkIds.includes(conflict.chunkId))?.evidenceChunkIds)
    .toEqual([conflict.chunkId]);
  expect(saved.sourceVersions).toEqual({ [a.sourceId]: 1, [b.sourceId]: 7, [conflict.sourceId]: 3 });
  const chunks = await createOpeningKnowledgeRepository(sql).listAuthorizedChunks(scope, courseId);
  expect(chunks.filter(chunk => merged?.evidenceChunkIds.includes(chunk.id)).map(chunk => ({
    sourceId: chunk.sourceId, version: chunk.sourceVersion, page: chunk.page,
  })).sort((left, right) => left.sourceId.localeCompare(right.sourceId))).toEqual([
    { sourceId: a.sourceId, version: a.version, page: a.page },
    { sourceId: b.sourceId, version: b.version, page: b.page },
  ].sort((left, right) => left.sourceId.localeCompare(right.sourceId)));
});

it("rebuilds with a new merged UUID while preserving the old referenced skill and repository identity guard", async () => {
  const { sql, scope } = fixture, courseId = randomUUID();
  await sql`INSERT INTO courses(id,workspace_id,title,slug)
    VALUES(${courseId},${scope.workspaceId},'Referenced course',${courseId})`;
  const a = await material(courseId, "x² + x₁", 1, 2);
  const original = await rebuild(courseId), oldNode = original.snapshot.nodes[0]!;
  // Existing course/exam binding is a durable identity reference, not a new ledger.
  const sprintId = randomUUID();
  await sql`INSERT INTO opening_exam_sprints(id,workspace_id,owner_user_id,pack_snapshot,state)
    VALUES(${sprintId},${scope.workspaceId},${scope.ownerUserId},'{}'::jsonb,'{}'::jsonb)`;
  await sql`INSERT INTO opening_exam_bindings(course_id,sprint_id,binding)
    VALUES(${courseId},${sprintId},${sql.json({ skills: [{ nodeId: oldNode.id }] })})`;
  const b = await material(courseId, "x² + x₁", 4, 19);
  const knowledge = createOpeningKnowledgeRepository(sql);
  const bindingBefore = await sql`SELECT * FROM opening_exam_bindings WHERE sprint_id=${sprintId}`;
  await expect(knowledge.replace(scope, courseId, {
    expectedVersion: 1,
    snapshot: { ...original.snapshot, nodes: [{ ...oldNode, evidenceChunkIds: [a.chunkId, b.chunkId] }] },
    sourceVersions: { [a.sourceId]: 1, [b.sourceId]: 4 },
  })).rejects.toMatchObject({ code: "CONFLICT" });
  const saved = await rebuild(courseId);
  expect(saved.version).toBe(2);
  expect(saved.snapshot.nodes).toHaveLength(2);
  expect(saved.snapshot.nodes.find(node => node.id === oldNode.id))
    .toMatchObject({ ...oldNode, evidenceChunkIds: [a.chunkId], status: "needs_check" });
  const merged = saved.snapshot.nodes.find(node => node.id !== oldNode.id)!;
  expect(merged.evidenceChunkIds.slice().sort()).toEqual([a.chunkId, b.chunkId].sort());
  expect(await sql`SELECT * FROM opening_exam_bindings WHERE sprint_id=${sprintId}`).toEqual(bindingBefore);
  expect(await knowledge.listReferencedNodeIds(scope, courseId)).toContain(oldNode.id);
  expect(saved.sourceVersions).toEqual({ [a.sourceId]: 1, [b.sourceId]: 4 });
});
