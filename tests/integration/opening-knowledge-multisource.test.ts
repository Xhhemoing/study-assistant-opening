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

it("persists exact-source unions and same-name different-text candidates without declaring semantic conflict", async () => {
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
  expect(merged?.status).toBe("needs_check");
  const separate = saved.snapshot.nodes.find(node => node.evidenceChunkIds.includes(conflict.chunkId));
  expect(separate?.evidenceChunkIds).toEqual([conflict.chunkId]);
  expect(separate?.status).toBe("needs_check");
  expect(separate?.id).not.toBe(merged?.id);
  expect(saved.snapshot.edges).toEqual([]);
  expect(saved.sourceVersions).toEqual({ [a.sourceId]: 1, [b.sourceId]: 7, [conflict.sourceId]: 3 });
  const chunks = await createOpeningKnowledgeRepository(sql).listAuthorizedChunks(scope, courseId);
  expect(chunks.filter(chunk => merged?.evidenceChunkIds.includes(chunk.id)).map(chunk => ({
    sourceId: chunk.sourceId, version: chunk.sourceVersion, page: chunk.page,
  })).sort((left, right) => left.sourceId.localeCompare(right.sourceId))).toEqual([
    { sourceId: a.sourceId, version: a.version, page: a.page },
    { sourceId: b.sourceId, version: b.version, page: b.page },
  ].sort((left, right) => left.sourceId.localeCompare(right.sourceId)));
  expect(chunks.find(chunk => chunk.id === conflict.chunkId))
    .toMatchObject({ sourceId: conflict.sourceId, sourceVersion: 3, page: 5, text: "café\nx2 + x₁" });
  // Persisted API readback carries status and original node evidence to the renderer.
  expect(await createOpeningKnowledgeRepository(sql).get(scope, courseId)).toEqual(saved);
});

it("preserves only the manually confirmed definition across rebuilds and rechecks changed source versions", async () => {
  const { sql, scope } = fixture, courseId = randomUUID();
  await sql`INSERT INTO courses(id,workspace_id,title,slug)
    VALUES(${courseId},${scope.workspaceId},'Manual review course',${courseId})`;
  const a = await material(courseId, "x² + x₁", 1, 2);
  const b = await material(courseId, "x² - x₁", 1, 3);
  const original = await rebuild(courseId);
  expect(original.snapshot.nodes.map(node => node.status)).toEqual(["needs_check", "needs_check"]);
  const selected = original.snapshot.nodes.find(node => node.evidenceChunkIds.includes(a.chunkId))!;
  const other = original.snapshot.nodes.find(node => node.evidenceChunkIds.includes(b.chunkId))!;
  const knowledge = createOpeningKnowledgeRepository(sql);
  const confirmed = await knowledge.confirmNode(scope, courseId, selected.id,
    { expectedVersion: original.version, sourceVersions: original.sourceVersions });
  expect(confirmed.snapshot.nodes.find(node => node.id === selected.id)!.status).toBe("supported");
  expect(confirmed.snapshot.nodes.find(node => node.id === other.id)!.status).toBe("needs_check");
  const preserved = await rebuild(courseId);
  expect(preserved.snapshot.nodes.find(node => node.id === selected.id)).toMatchObject({ ...selected, status: "supported" });
  expect(preserved.snapshot.nodes.find(node => node.id === other.id)).toEqual(other);
  // Same complete text/UUID but a changed source version still invalidates the confirmation.
  await sql`UPDATE opening_sources SET version=2 WHERE id=${a.sourceId}`;
  await sql`INSERT INTO opening_source_versions(source_id,version,workspace_id,bytes,sha256,availability)
    SELECT id,version,workspace_id,bytes,sha256,'available' FROM opening_sources WHERE id=${a.sourceId}`;
  await sql`UPDATE opening_source_chunks SET source_version=2 WHERE id=${a.chunkId}`;
  await knowledge.markNeedsCheckForSources(scope, [a.sourceId]);
  const changed = await rebuild(courseId);
  expect(changed.snapshot.nodes.map(node => node.status)).toEqual(["needs_check", "needs_check"]);
  expect(changed.snapshot.nodes.find(node => node.id === selected.id)!.evidenceChunkIds).toEqual([a.chunkId]);
  expect(changed.sourceVersions).toEqual({ [a.sourceId]: 2, [b.sourceId]: 1 });
  expect(await sql`SELECT id FROM opening_knowledge_confirmations WHERE course_id=${courseId}`).toHaveLength(1);
});

it("keeps exact complete definitions supported through real extraction merge, replacement and readback", async () => {
  const { sql, scope } = fixture, courseId = randomUUID();
  await sql`INSERT INTO courses(id,workspace_id,title,slug)
    VALUES(${courseId},${scope.workspaceId},'Exact definitions',${courseId})`;
  const a = await material(courseId, "cafe\u0301\r\nx² + x₁", 1, 2);
  const b = await material(courseId, "café\nx² + x₁", 7, 42);
  const saved = await rebuild(courseId);
  expect(saved.snapshot.nodes).toHaveLength(1);
  expect(saved.snapshot.nodes[0]).toMatchObject({ courseId, kind: "concept", label: "向量的定义", status: "supported" });
  expect(saved.snapshot.nodes[0]!.evidenceChunkIds.slice().sort()).toEqual([a.chunkId, b.chunkId].sort());
  expect(saved.sourceVersions).toEqual({ [a.sourceId]: 1, [b.sourceId]: 7 });
  expect(await createOpeningKnowledgeRepository(sql).get(scope, courseId)).toEqual(saved);
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
