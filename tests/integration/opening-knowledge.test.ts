import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { KnowledgeSnapshot } from "@aistudy/contracts";
import {
  createOpeningKnowledgeRepository,
  createOpeningSourceActionsRepository,
  createOpeningSourceChunksRepository,
  OpeningKnowledgeError,
} from "@aistudy/database";
import { validateKnowledgeSnapshot } from "@aistudy/domain";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { backupRows } from "./opening-backup-records-fixture";

let f: OpeningFixture;

beforeAll(async () => {
  f = await createOpeningFixture();
});
afterAll(async () => {
  if (!f) return;
  await f.sql`DELETE FROM workspaces WHERE id IN (${f.scope.workspaceId},${f.otherScope.workspaceId})`;
  await f.close();
});
beforeEach(async () => {
  await f.sql`TRUNCATE opening_course_knowledge, opening_outbox, opening_jobs, opening_source_chunks, opening_sources, course_asset_memberships RESTART IDENTITY CASCADE`;
  await f.sql`DELETE FROM courses WHERE workspace_id IN (${f.scope.workspaceId},${f.otherScope.workspaceId})`;
});

async function seedCourseMaterial(scope = f.scope) {
  const rows = backupRows(f.sql, scope);
  const sourceId = await rows.source();
  const chunkId = await rows.chunk(sourceId);
  await f.sql`INSERT INTO opening_source_versions(source_id,version,workspace_id,bytes,sha256,availability)
    SELECT id,version,workspace_id,bytes,sha256,'available' FROM opening_sources WHERE id=${sourceId}`;
  const courseId = randomUUID();
  await f.sql`INSERT INTO courses (id, workspace_id, title, slug)
    VALUES (${courseId}, ${scope.workspaceId}, 'Knowledge course', ${courseId})`;
  await f.sql`INSERT INTO course_asset_memberships
    (id, workspace_id, course_id, asset_type, asset_id, role, sort_order, visibility)
    VALUES (${randomUUID()}, ${scope.workspaceId}, ${courseId}, 'source', ${sourceId}, 'core', 0, 'course')`;
  return { courseId, sourceId, chunkId };
}

function nodeIds() {
  return {
    a: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
    b: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
  };
}

function snapshotFor(
  courseId: string,
  chunkId: string,
  version: number,
  opts?: { cycle?: boolean; foreignChunk?: string },
): KnowledgeSnapshot {
  const ids = nodeIds();
  const nodes = [
    {
      id: ids.a,
      courseId,
      label: "函数",
      kind: "concept" as const,
      evidenceChunkIds: [opts?.foreignChunk ?? chunkId],
      status: "supported" as const,
    },
    {
      id: ids.b,
      courseId,
      label: "映射",
      kind: "concept" as const,
      evidenceChunkIds: [chunkId],
      status: "supported" as const,
    },
  ];
  const edges = opts?.cycle
    ? [
        {
          from: ids.a,
          to: ids.b,
          kind: "prerequisite" as const,
          evidenceChunkIds: [chunkId],
          status: "supported" as const,
        },
        {
          from: ids.b,
          to: ids.a,
          kind: "prerequisite" as const,
          evidenceChunkIds: [chunkId],
          status: "supported" as const,
        },
      ]
    : [
        {
          from: ids.a,
          to: ids.b,
          kind: "prerequisite" as const,
          evidenceChunkIds: [chunkId],
          status: "supported" as const,
        },
      ];
  return { courseId, version, nodes, edges };
}

describe("opening knowledge repository", () => {
  it("returns null from get/getVersion when no row exists", async () => {
    const { courseId } = await seedCourseMaterial();
    const repo = createOpeningKnowledgeRepository(f.sql);
    await expect(repo.get(f.scope, courseId)).resolves.toBeNull();
    await expect(repo.getVersion(f.scope, courseId)).resolves.toBeNull();
  });

  it("idempotently replaces the same snapshot via soft CAS replay", async () => {
    const { courseId, sourceId, chunkId } = await seedCourseMaterial();
    const repo = createOpeningKnowledgeRepository(f.sql);
    const snap = snapshotFor(courseId, chunkId, 1);
    const first = await repo.replace(f.scope, courseId, {
      expectedVersion: 0,
      snapshot: snap,
      sourceVersions: { [sourceId]: 1 },
    });
    expect(first.version).toBe(1);
    expect(first.snapshot.version).toBe(1);

    const replay = await repo.replace(f.scope, courseId, {
      expectedVersion: 0,
      snapshot: snap,
      sourceVersions: { [sourceId]: 1 },
    });
    expect(replay.version).toBe(1);
    expect(replay.snapshot.nodes).toEqual(first.snapshot.nodes);

    const loaded = await repo.get(f.scope, courseId);
    expect(loaded?.version).toBe(1);
    expect(await repo.getVersion(f.scope, courseId)).toBe(1);
  });

  it("rejects illegal chunk refs", async () => {
    const { courseId, sourceId, chunkId } = await seedCourseMaterial();
    const foreign = randomUUID();
    const repo = createOpeningKnowledgeRepository(f.sql);
    await expect(
      repo.replace(f.scope, courseId, {
        expectedVersion: 0,
        snapshot: snapshotFor(courseId, chunkId, 1, { foreignChunk: foreign }),
        sourceVersions: { [sourceId]: 1 },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it.each(["version", "privacy", "parse", "history"])("rejects evidence that became unavailable before replace: %s", async change => {
    const { courseId, sourceId, chunkId } = await seedCourseMaterial();
    const repo = createOpeningKnowledgeRepository(f.sql);
    expect(await repo.listAuthorizedChunks(f.scope, courseId)).toHaveLength(1);
    if (change === "version") await f.sql`UPDATE opening_sources SET version=2 WHERE id=${sourceId}`;
    if (change === "privacy") await f.sql`INSERT INTO opening_privacy_exclusions(workspace_id,source_id) VALUES(${f.scope.workspaceId},${sourceId})`;
    if (change === "parse") await f.sql`UPDATE opening_sources SET parse_state='queued' WHERE id=${sourceId}`;
    if (change === "history") await f.sql`UPDATE opening_source_versions SET availability='unavailable' WHERE source_id=${sourceId}`;
    expect(await repo.listAuthorizedChunks(f.scope, courseId)).toHaveLength(0);
    await expect(repo.replace(f.scope, courseId, { expectedVersion: 0,
      snapshot: snapshotFor(courseId, chunkId, 1), sourceVersions: { [sourceId]: 1 } })).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await repo.get(f.scope, courseId)).toBeNull();
  });
  it("requires a new UUID for a semantic edit while allowing status-only review", async () => {
    const { courseId, sourceId, chunkId } = await seedCourseMaterial();
    const repo = createOpeningKnowledgeRepository(f.sql), original = snapshotFor(courseId, chunkId, 1);
    const saved = await repo.replace(f.scope, courseId, { expectedVersion: 0, snapshot: original, sourceVersions: { [sourceId]: 1 } });
    await expect(repo.replace(f.scope, courseId, { expectedVersion: 1, sourceVersions: { [sourceId]: 1 },
      snapshot: { ...saved.snapshot, nodes: saved.snapshot.nodes.map((node, index) => index === 0 ? { ...node, label: "Different meaning" } : node) } }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    const reviewed = await repo.replace(f.scope, courseId, { expectedVersion: 1, sourceVersions: { [sourceId]: 1 },
      snapshot: { ...saved.snapshot, nodes: saved.snapshot.nodes.map(node => ({ ...node, status: "needs_check" })) } });
    expect(reviewed.snapshot.nodes.map(node => node.id)).toEqual(saved.snapshot.nodes.map(node => node.id));
  });

  it("keeps node IDs after identical text is reparsed and never exposes the private definition map", async () => {
    const { courseId, sourceId, chunkId } = await seedCourseMaterial();
    const repo = createOpeningKnowledgeRepository(f.sql);
    const original = await repo.replace(f.scope, courseId, { expectedVersion: 0,
      snapshot: snapshotFor(courseId, chunkId, 1), sourceVersions: { [sourceId]: 1 } });
    expect(Object.keys((await repo.getForRebuild(f.scope, courseId))!.nodeDefinitions)).toHaveLength(2);
    expect(await repo.get(f.scope, courseId)).not.toHaveProperty("nodeDefinitions");
    const replacement = randomUUID();
    await f.sql`UPDATE opening_source_chunks SET id=${replacement} WHERE id=${chunkId}`;
    const graph = snapshotFor(courseId, replacement, 2);
    const saved = await repo.replace(f.scope, courseId, { expectedVersion: 1, snapshot: graph, sourceVersions: { [sourceId]: 1 } });
    expect(saved.snapshot.nodes.map(node => node.id)).toEqual(original.snapshot.nodes.map(node => node.id));
    expect(saved.snapshot.nodes[0]!.evidenceChunkIds).toEqual([replacement]);
    const another = randomUUID();
    await f.sql`UPDATE opening_source_chunks SET id=${another},text=text || ' with a changed mathematical definition'
      WHERE id=${replacement}`;
    await expect(repo.replace(f.scope, courseId, { expectedVersion: 2,
      snapshot: snapshotFor(courseId, another, 3), sourceVersions: { [sourceId]: 1 } })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it.each(["exclude", "delete"] as const)("clears private definition text on material %s and rejects another batch send", async action => {
    const { courseId, sourceId, chunkId } = await seedCourseMaterial();
    await f.sql`UPDATE opening_source_chunks SET image_object_key=NULL WHERE source_id=${sourceId}`;
    const repo = createOpeningKnowledgeRepository(f.sql);
    const chunks = await repo.listAuthorizedChunks(f.scope, courseId);
    await repo.replace(f.scope, courseId, { expectedVersion: 0,
      snapshot: snapshotFor(courseId, chunkId, 1), sourceVersions: { [sourceId]: 1 } });
    const sources = createOpeningSourceActionsRepository(f.sql);
    const impact = await sources.impact(f.scope, sourceId);
    await sources.apply(f.scope, sourceId, { action, expectedVersion: 1, expectedMembershipIds: impact.courses.map(course => course.membershipId) },
      { stagingKey: id => `opening/sources/${id}/staging`, finalKey: (id, version) => `opening/sources/${id}/${version}` }, new Date());
    expect((await repo.getForRebuild(f.scope, courseId))!.nodeDefinitions).toEqual({});
    await expect(repo.assertExtractionBatch(f.scope, courseId, chunks)).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it.each([false, true])("checks the course owner before authorizing a batch without a job claim (empty: %s)", async empty => {
    const { courseId } = await seedCourseMaterial();
    const repo = createOpeningKnowledgeRepository(f.sql);
    const chunks = empty ? [] : await repo.listAuthorizedChunks(f.scope, courseId);
    await expect(repo.assertExtractionBatch({ ...f.scope, ownerUserId: f.otherScope.ownerUserId }, courseId, chunks))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it.each([false, true])("preserves an existing graph before its first reparse, without recovering excluded text (%s)", async excluded => {
    const { courseId, sourceId, chunkId } = await seedCourseMaterial();
    const repo = createOpeningKnowledgeRepository(f.sql);
    const original = await repo.replace(f.scope, courseId, { expectedVersion: 0,
      snapshot: snapshotFor(courseId, chunkId, 1), sourceVersions: { [sourceId]: 1 } });
    await f.sql`UPDATE opening_course_knowledge SET node_definitions='{}'::jsonb WHERE course_id=${courseId}`;
    const chunks = createOpeningSourceChunksRepository(f.sql);
    const old = (await chunks.listChunks(f.scope, sourceId))[0]!;
    if (excluded) await f.sql`INSERT INTO opening_privacy_exclusions(workspace_id,source_id,deleted_at)
      VALUES(${f.scope.workspaceId},${sourceId},now())`;
    await chunks.replaceChunks(f.scope, { sourceId, sourceVersion: 1, chunks: [{ page: old.page, slideLabel: old.slideLabel,
      startMs: old.startMs, endMs: old.endMs, text: old.text, imageObjectKey: old.imageObjectKey }] });
    const definitions = (await repo.getForRebuild(f.scope, courseId))!.nodeDefinitions;
    if (excluded) { expect(definitions).toEqual({}); return; }
    expect(Object.keys(definitions)).toHaveLength(2);
    const replacement = (await chunks.listChunks(f.scope, sourceId))[0]!;
    expect(replacement.id).toBe(chunkId);
    const saved = await repo.replace(f.scope, courseId, { expectedVersion: 1,
      snapshot: snapshotFor(courseId, replacement.id, 2), sourceVersions: { [sourceId]: 1 } });
    expect(saved.snapshot.nodes.map(node => node.id)).toEqual(original.snapshot.nodes.map(node => node.id));
  });

  it("replaces changed reparse evidence without silently reassigning the old graph's skill identities", async () => {
    const { courseId, sourceId, chunkId } = await seedCourseMaterial();
    const repo = createOpeningKnowledgeRepository(f.sql);
    const original = await repo.replace(f.scope, courseId, { expectedVersion: 0,
      snapshot: snapshotFor(courseId, chunkId, 1), sourceVersions: { [sourceId]: 1 } });
    await f.sql`UPDATE opening_course_knowledge SET node_definitions='{}'::jsonb WHERE course_id=${courseId}`;
    const chunks = createOpeningSourceChunksRepository(f.sql), old = (await chunks.listChunks(f.scope, sourceId))[0]!;
    await chunks.replaceChunks(f.scope, { sourceId, sourceVersion: 1, chunks: [{ page: old.page, slideLabel: old.slideLabel,
      startMs: old.startMs, endMs: old.endMs, text: `${old.text} with a changed mathematical definition`, imageObjectKey: old.imageObjectKey }] });
    const changed = (await chunks.listChunks(f.scope, sourceId))[0]!;
    expect(changed.id).not.toBe(chunkId);
    expect((await repo.get(f.scope, courseId))!.snapshot).toEqual(original.snapshot);
    expect(Object.keys((await repo.getForRebuild(f.scope, courseId))!.nodeDefinitions)).toHaveLength(2);
    await expect(repo.replace(f.scope, courseId, { expectedVersion: 1,
      snapshot: snapshotFor(courseId, changed.id, 2), sourceVersions: { [sourceId]: 1 } })).rejects.toMatchObject({ code: "CONFLICT" });
    const rebuilt = snapshotFor(courseId, changed.id, 2);
    const ids = new Map(rebuilt.nodes.map(node => [node.id, randomUUID()]));
    rebuilt.nodes = rebuilt.nodes.map(node => ({ ...node, id: ids.get(node.id)! }));
    rebuilt.edges = rebuilt.edges.map(edge => ({ ...edge, from: ids.get(edge.from)!, to: ids.get(edge.to)! }));
    const saved = await repo.replace(f.scope, courseId, { expectedVersion: 1, snapshot: rebuilt, sourceVersions: { [sourceId]: 1 } });
    expect(saved.snapshot.nodes.map(node => node.id)).toEqual(rebuilt.nodes.map(node => node.id));
    expect(saved.snapshot.nodes.map(node => node.id)).not.toEqual(original.snapshot.nodes.map(node => node.id));
    expect(saved.snapshot.nodes.every(node => node.evidenceChunkIds.includes(changed.id))).toBe(true);
  });

  it("rejects other owner / other course", async () => {
    const mine = await seedCourseMaterial(f.scope);
    const other = await seedCourseMaterial(f.otherScope);
    const repo = createOpeningKnowledgeRepository(f.sql);
    await expect(repo.get(f.otherScope, mine.courseId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      repo.replace(f.scope, other.courseId, {
        expectedVersion: 0,
        snapshot: snapshotFor(other.courseId, other.chunkId, 1),
        sourceVersions: { [other.sourceId]: 1 },
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects prerequisite cycles before persist", async () => {
    const { courseId, sourceId, chunkId } = await seedCourseMaterial();
    const repo = createOpeningKnowledgeRepository(f.sql);
    const cyclic = snapshotFor(courseId, chunkId, 1, { cycle: true });
    expect(() => validateKnowledgeSnapshot({ ...cyclic, version: 1 })).toThrow(/cycle/i);
    await expect(
      repo.replace(f.scope, courseId, {
        expectedVersion: 0,
        snapshot: cyclic,
        sourceVersions: { [sourceId]: 1 },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(repo.get(f.scope, courseId)).resolves.toBeNull();
  });

  it("conflicts on stale expectedVersion", async () => {
    const { courseId, sourceId, chunkId } = await seedCourseMaterial();
    const repo = createOpeningKnowledgeRepository(f.sql);
    await repo.replace(f.scope, courseId, {
      expectedVersion: 0,
      snapshot: snapshotFor(courseId, chunkId, 1),
      sourceVersions: { [sourceId]: 1 },
    });
    await expect(
      repo.replace(f.scope, courseId, {
        expectedVersion: 0,
        snapshot: {
          ...snapshotFor(courseId, chunkId, 1),
          nodes: [
            {
              id: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
              courseId,
              label: "不同",
              kind: "concept",
              evidenceChunkIds: [chunkId],
              status: "supported",
            },
          ],
          edges: [],
        },
        sourceVersions: { [sourceId]: 1 },
      }),
    ).rejects.toBeInstanceOf(OpeningKnowledgeError);
  });

  it("enqueues build-course-knowledge rebuild jobs", async () => {
    const { courseId } = await seedCourseMaterial();
    const repo = createOpeningKnowledgeRepository(f.sql);
    const first = await repo.enqueueRebuild(f.scope, courseId, { clientKey: "rebuild-key-01" });
    expect(first).toMatchObject({ kind: "build-course-knowledge", created: true });
    const replay = await repo.enqueueRebuild(f.scope, courseId, { clientKey: "rebuild-key-01" });
    expect(replay).toEqual({ jobId: first.jobId, kind: "build-course-knowledge", created: false });

    const jobs = await f.sql`
      SELECT kind, payload FROM opening_jobs WHERE id = ${first.jobId}`;
    expect(jobs[0]).toMatchObject({
      kind: "build-course-knowledge",
      payload: { courseId },
    });
    const outbox = await f.sql`
      SELECT payload FROM opening_outbox WHERE job_id = ${first.jobId}`;
    expect(outbox[0]?.payload).toMatchObject({
      kind: "build-course-knowledge",
      courseId,
      jobId: first.jobId,
    });
  });

  it("lists authorized chunks for the course only", async () => {
    const mine = await seedCourseMaterial(f.scope);
    const other = await seedCourseMaterial(f.scope);
    const repo = createOpeningKnowledgeRepository(f.sql);
    const chunks = await repo.listAuthorizedChunks(f.scope, mine.courseId);
    expect(chunks.map((c) => c.id)).toEqual([mine.chunkId]);
    expect(chunks[0]?.courseId).toBe(mine.courseId);
    expect(chunks.map((c) => c.id)).not.toContain(other.chunkId);
  });
});
