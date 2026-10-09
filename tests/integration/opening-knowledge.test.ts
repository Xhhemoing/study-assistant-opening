import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { KnowledgeSnapshot } from "@aistudy/contracts";
import {
  createOpeningKnowledgeRepository,
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
