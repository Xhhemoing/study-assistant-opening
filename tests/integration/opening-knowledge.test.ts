import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { KnowledgeSnapshot } from "@aistudy/contracts";
import {
  createOpeningKnowledgeRepository,
  createSqlClient,
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

// Pause only the test's transaction boundary AFTER real repository SQL ran, BEFORE commit.
// No query mock, database trigger, production hook or timing sleep controls these interleavings.
async function pauseBeforeCommit<T>(operation: (repo: ReturnType<typeof createOpeningKnowledgeRepository>) => Promise<T>) {
  let release!: () => void, reached!: () => void;
  const ready = new Promise<void>(resolve => { reached = resolve; });
  const proceed = new Promise<void>(resolve => { release = resolve; });
  let pid = 0;
  const gated = new Proxy(f.sql, {
    get(target, property) {
      if (property !== "begin") return Reflect.get(target, property);
      return (callback: (tx: Sql) => Promise<T>) => target.begin(async tx => {
        const [backend] = await tx`SELECT pg_backend_pid() AS pid`;
        pid = Number(backend!.pid);
        const result = await callback(tx as unknown as Sql);
        reached();
        await proceed;
        return result;
      });
    },
  });
  const result = operation(createOpeningKnowledgeRepository(gated));
  await Promise.race([ready, result.then(() => { throw new Error("Expected a transaction paused before commit"); })]);
  return { result, release, pid };
}

async function expectBlockedBy(pid: number, blocker: number) {
  // Observe the real server lock dependency, not elapsed time or a promise that merely started.
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [row] = await f.sql`SELECT ${blocker}::integer = ANY(pg_blocking_pids(${pid})) AS blocked`;
    if (row!.blocked) return;
  }
  throw new Error("Concurrent repository transaction never reached the expected PostgreSQL lock barrier");
}

describe("opening knowledge manual confirmation", () => {
  async function pending() {
    const material = await seedCourseMaterial();
    const repo = createOpeningKnowledgeRepository(f.sql);
    const snapshot = snapshotFor(material.courseId, material.chunkId, 1);
    snapshot.nodes[0]!.status = "needs_check";
    const record = await repo.replace(f.scope, material.courseId, { expectedVersion: 0, snapshot,
      sourceVersions: { [material.sourceId]: 1 } });
    return { ...material, repo, record, nodeId: snapshot.nodes[0]!.id };
  }

  it("confirms only the selected node and atomically records the observed evidence", async () => {
    const { repo, courseId, nodeId, record, chunkId, sourceId } = await pending();
    const result = await repo.confirmNode(f.scope, courseId, nodeId, { expectedVersion: 1, sourceVersions: record.sourceVersions });
    expect(result.version).toBe(2);
    expect(result.snapshot.nodes[0]!.status).toBe("supported");
    expect(result.snapshot.nodes.slice(1)).toEqual(record.snapshot.nodes.slice(1));
    expect(result.snapshot.edges).toEqual(record.snapshot.edges);
    expect(await repo.get(f.scope, courseId)).toEqual(result);
    const audit = await f.sql`SELECT * FROM opening_knowledge_confirmations WHERE course_id=${courseId}`;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ workspace_id: f.scope.workspaceId, owner_user_id: f.scope.ownerUserId,
      course_id: courseId, node_id: nodeId, graph_version_before: 1, graph_version_after: 2,
      source_versions: { [sourceId]: 1 }, evidence_chunk_ids: [chunkId] });
    expect(audit[0]!.confirmed_at).toBeTruthy();
    await expect(repo.confirmNode(f.scope, courseId, nodeId, { expectedVersion: 1, sourceVersions: record.sourceVersions }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(await f.sql`SELECT id FROM opening_knowledge_confirmations WHERE course_id=${courseId}`).toHaveLength(1);
  });

  it.each(["supported", "suggested"] as const)("rejects the %s state without writing an audit record", async status => {
    const { repo, courseId, nodeId, record } = await pending();
    const snapshot = structuredClone(record.snapshot); snapshot.nodes[0]!.status = status;
    await f.sql`UPDATE opening_course_knowledge SET snapshot=${f.sql.json(snapshot as never)} WHERE course_id=${courseId}`;
    await expect(repo.confirmNode(f.scope, courseId, nodeId, { expectedVersion: 1, sourceVersions: record.sourceVersions }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(await f.sql`SELECT id FROM opening_knowledge_confirmations WHERE course_id=${courseId}`).toHaveLength(0);
  });

  it("returns NOT_FOUND for an archived course without writing", async () => {
    const { repo, courseId, nodeId, record } = await pending();
    await f.sql`UPDATE courses SET archived_at=now() WHERE id=${courseId}`;
    await expect(repo.confirmNode(f.scope, courseId, nodeId, { expectedVersion: 1, sourceVersions: record.sourceVersions }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    const [row] = await f.sql`SELECT version,snapshot FROM opening_course_knowledge WHERE course_id=${courseId}`;
    expect(Number(row!.version)).toBe(1);
    expect(row!.snapshot).toEqual(record.snapshot);
    expect(await f.sql`SELECT id FROM opening_knowledge_confirmations WHERE course_id=${courseId}`).toHaveLength(0);
  });

  it.each(["request", "live", "missing", "extra", "evidence", "privacy", "membership", "unavailable"])("conflicts on changed provenance even with an unchanged graph version: %s", async change => {
    const { repo, courseId, nodeId, sourceId, chunkId, record } = await pending();
    const sourceVersions = { ...record.sourceVersions };
    if (change === "request") sourceVersions[sourceId] = 2;
    if (change === "live") {
      // A real v2 row: the conflict comes from the version mismatch, not from the JOIN dropping the source.
      await f.sql`UPDATE opening_sources SET version=2 WHERE id=${sourceId}`;
      await f.sql`INSERT INTO opening_source_versions(source_id,version,workspace_id,bytes,sha256,availability)
        SELECT id,version,workspace_id,bytes,sha256,'available' FROM opening_sources WHERE id=${sourceId}`;
    }
    if (change === "missing") delete sourceVersions[sourceId];
    if (change === "extra") sourceVersions[randomUUID()] = 1;
    if (change === "evidence") await f.sql`DELETE FROM opening_source_chunks WHERE id=${chunkId}`;
    if (change === "privacy") await f.sql`INSERT INTO opening_privacy_exclusions(workspace_id,source_id) VALUES(${f.scope.workspaceId},${sourceId})`;
    if (change === "membership") await f.sql`DELETE FROM course_asset_memberships WHERE course_id=${courseId} AND asset_id=${sourceId}`;
    if (change === "unavailable") await f.sql`UPDATE opening_source_versions SET availability='unavailable' WHERE source_id=${sourceId}`;
    await expect(repo.confirmNode(f.scope, courseId, nodeId, { expectedVersion: 1, sourceVersions }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect((await repo.get(f.scope, courseId))!.snapshot.nodes[0]!.status).toBe("needs_check");
    expect(await repo.getVersion(f.scope, courseId)).toBe(1);
    expect(await f.sql`SELECT id FROM opening_knowledge_confirmations WHERE course_id=${courseId}`).toHaveLength(0);
  });

  it("rejects other workspaces and forged owners", async () => {
    const { repo, courseId, nodeId, record } = await pending();
    for (const scope of [f.otherScope, { ...f.scope, ownerUserId: f.otherScope.ownerUserId }]) {
      await expect(repo.confirmNode(scope, courseId, nodeId, { expectedVersion: 1, sourceVersions: record.sourceVersions }))
        .rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect(await f.sql`SELECT id FROM opening_knowledge_confirmations WHERE course_id=${courseId}`).toHaveLength(0);
  });

  it("serializes simultaneous submissions: one transition and one audit only", async () => {
    const { repo, courseId, nodeId, record } = await pending();
    const results = await Promise.allSettled([1, 2].map(() => repo.confirmNode(f.scope, courseId, nodeId,
      { expectedVersion: 1, sourceVersions: record.sourceVersions })));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "CONFLICT" } });
    expect(await f.sql`SELECT id FROM opening_knowledge_confirmations WHERE course_id=${courseId}`).toHaveLength(1);
  });

  it("rejects confirmation after a source-version commit that left the graph version unchanged", async () => {
    // Ordering note: confirmNode first takes workspace/course and graph FOR UPDATE, so the
    // released bump has in practice committed before the sources/versions FOR SHARE read; this
    // proves the committed-bump-then-confirm order. Either interleaving serializes: if confirm
    // holds FOR SHARE first, the version UPDATE waits for it; if confirm's FOR SHARE waits on
    // an uncommitted bump, EPQ re-checks the join and excludes the row (CONFLICT).
    const { repo, courseId, nodeId, record, sourceId } = await pending();
    let release!: () => void, locked!: () => void;
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const proceed = new Promise<void>(resolve => { release = resolve; });
    const bump = f.sql.begin(async tx => {
      await tx`UPDATE opening_sources SET version=2 WHERE id=${sourceId}`;
      locked(); await proceed;
    });
    await ready;
    const confirming = repo.confirmNode(f.scope, courseId, nodeId, { expectedVersion: 1, sourceVersions: record.sourceVersions });
    release(); await bump;
    await expect(confirming).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await repo.get(f.scope, courseId)).toEqual(record);
    expect(await f.sql`SELECT id FROM opening_knowledge_confirmations WHERE course_id=${courseId}`).toHaveLength(0);
  });

  it.each(["confirm", "replace"] as const)("maintenance commits before queued %s: stale CAS conflicts without resurrecting receipts", async operation => {
    const { repo, courseId, nodeId, record, sourceId } = await pending();
    const confirmed = await repo.confirmNode(f.scope, courseId, nodeId,
      { expectedVersion: record.version, sourceVersions: record.sourceVersions });
    await repo.markNeedsCheckForSources(f.scope, [sourceId]);
    const alreadyPending = (await repo.get(f.scope, courseId))!;
    expect(alreadyPending.snapshot.nodes.every(node => node.status === "needs_check")).toBe(true);
    expect(await f.sql`SELECT id FROM opening_knowledge_confirmations WHERE course_id=${courseId}`).toHaveLength(0);
    const maintenance = await pauseBeforeCommit(gated => gated.markNeedsCheckForSources(f.scope, [sourceId]));
    const contender = createSqlClient(process.env.OPENING_TEST_DATABASE_URL!, { max: 1 });
    let queued: Promise<unknown> | undefined;
    try {
      const [backend] = await contender`SELECT pg_backend_pid() AS pid`;
      const concurrent = createOpeningKnowledgeRepository(contender);
      queued = operation === "confirm"
        ? concurrent.confirmNode(f.scope, courseId, nodeId,
          { expectedVersion: alreadyPending.version, sourceVersions: alreadyPending.sourceVersions })
        : concurrent.replace(f.scope, courseId, { expectedVersion: alreadyPending.version,
          expectedReferencedNodeIds: [], snapshot: structuredClone(alreadyPending.snapshot), sourceVersions: alreadyPending.sourceVersions });
      const outcome = queued.then(value => ({ value }), error => ({ error }));
      await expectBlockedBy(Number(backend!.pid), maintenance.pid);
      // The receipt deletion / CAS update is not visible before the maintenance commit.
      expect(await repo.get(f.scope, courseId)).toEqual(alreadyPending);
      maintenance.release();
      expect(await maintenance.result).toEqual({ updated: 0, courseIds: [courseId] });
      expect(await outcome).toMatchObject({ error: { code: "CONFLICT" } });
      const maintained = (await repo.get(f.scope, courseId))!;
      expect(maintained.version).toBe(alreadyPending.version + 1);
      expect(maintained.snapshot.nodes.every(node => node.status === "needs_check")).toBe(true);
      expect(await f.sql`SELECT id FROM opening_knowledge_confirmations WHERE course_id=${courseId}`).toHaveLength(0);
      const rebuilt = await repo.replace(f.scope, courseId, { expectedVersion: maintained.version,
        expectedReferencedNodeIds: [], snapshot: structuredClone(confirmed.snapshot), sourceVersions: confirmed.sourceVersions });
      expect(rebuilt.snapshot.nodes.every(node => node.status === "needs_check")).toBe(true);
      expect(await f.sql`SELECT id FROM opening_knowledge_confirmations WHERE course_id=${courseId}`).toHaveLength(0);
      const checked = await repo.confirmNode(f.scope, courseId, nodeId,
        { expectedVersion: rebuilt.version, sourceVersions: rebuilt.sourceVersions });
      expect(checked.snapshot.nodes.find(node => node.id === nodeId)!.status).toBe("supported");
      const receipts = await f.sql`SELECT graph_version_before,graph_version_after FROM opening_knowledge_confirmations WHERE course_id=${courseId}`;
      expect(receipts).toEqual([{ graph_version_before: rebuilt.version, graph_version_after: checked.version }]);
    } finally {
      maintenance.release();
      await Promise.allSettled([maintenance.result, ...(queued ? [queued] : [])]);
      await contender.end({ timeout: 5 });
    }
  });

  it.each(["confirm", "replace"] as const)("maintenance waits for %s commit, then permanently revokes its confirmation", async operation => {
    const { repo, courseId, nodeId, record, sourceId } = await pending();
    const before = operation === "replace" ? await repo.confirmNode(f.scope, courseId, nodeId,
      { expectedVersion: record.version, sourceVersions: record.sourceVersions }) : record;
    const writer = await pauseBeforeCommit(gated => operation === "confirm"
      ? gated.confirmNode(f.scope, courseId, nodeId, { expectedVersion: before.version, sourceVersions: before.sourceVersions })
      : gated.replace(f.scope, courseId, { expectedVersion: before.version, expectedReferencedNodeIds: [],
        snapshot: structuredClone(record.snapshot), sourceVersions: before.sourceVersions }));
    const contender = createSqlClient(process.env.OPENING_TEST_DATABASE_URL!, { max: 1 });
    let queued: Promise<unknown> | undefined;
    try {
      const [backend] = await contender`SELECT pg_backend_pid() AS pid`;
      queued = createOpeningKnowledgeRepository(contender).markNeedsCheckForSources(f.scope, [sourceId]);
      await expectBlockedBy(Number(backend!.pid), writer.pid);
      expect(await repo.get(f.scope, courseId)).toEqual(before);
      writer.release();
      const written = await writer.result;
      await queued;
      const maintained = (await repo.get(f.scope, courseId))!;
      expect(maintained.version).toBe(written.version + 1);
      expect(maintained.snapshot.nodes.every(node => node.status === "needs_check")).toBe(true);
      expect(await f.sql`SELECT id FROM opening_knowledge_confirmations WHERE course_id=${courseId}`).toHaveLength(0);
      const rebuilt = await repo.replace(f.scope, courseId, { expectedVersion: maintained.version,
        expectedReferencedNodeIds: [], snapshot: structuredClone(written.snapshot), sourceVersions: written.sourceVersions });
      expect(rebuilt.snapshot.nodes.every(node => node.status === "needs_check")).toBe(true);
      expect(await f.sql`SELECT id FROM opening_knowledge_confirmations WHERE course_id=${courseId}`).toHaveLength(0);
    } finally {
      writer.release();
      await Promise.allSettled([writer.result, ...(queued ? [queued] : [])]);
      await contender.end({ timeout: 5 });
    }
  });

  it("scope-isolates maintenance and rejects forged owners without changing graph or receipts", async () => {
    const { repo, courseId, nodeId, record, sourceId } = await pending();
    const confirmed = await repo.confirmNode(f.scope, courseId, nodeId,
      { expectedVersion: record.version, sourceVersions: record.sourceVersions });
    const receipts = await f.sql`SELECT * FROM opening_knowledge_confirmations WHERE course_id=${courseId}`;
    await expect(repo.markNeedsCheckForSources({ ...f.scope, ownerUserId: f.otherScope.ownerUserId }, [sourceId]))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await repo.markNeedsCheckForSources(f.otherScope, [sourceId])).toEqual({ updated: 0, courseIds: [] });
    expect(await repo.get(f.scope, courseId)).toEqual(confirmed);
    expect(await f.sql`SELECT * FROM opening_knowledge_confirmations WHERE course_id=${courseId}`).toEqual(receipts);
  });

  it("rolls back maintenance receipt deletion, CAS update and graph changes on a real transaction failure", async () => {
    const { repo, courseId, nodeId, record, sourceId } = await pending();
    const confirmed = await repo.confirmNode(f.scope, courseId, nodeId,
      { expectedVersion: record.version, sourceVersions: record.sourceVersions });
    const receipts = await f.sql`SELECT * FROM opening_knowledge_confirmations WHERE course_id=${courseId}`;
    // Test-only outer transaction: the repository's real maintenance runs in a savepoint.
    // Division by zero aborts AFTER its DELETE/UPDATE, proving both roll back together.
    await expect(f.sql.begin(async tx => {
      const nested = createOpeningKnowledgeRepository(new Proxy(f.sql, {
        get(target, property) {
          return property === "begin" ? (callback: (inner: Sql) => Promise<unknown>) =>
            tx.savepoint(inner => callback(inner as unknown as Sql)) : Reflect.get(target, property);
        },
      }));
      await nested.markNeedsCheckForSources(f.scope, [sourceId]);
      expect(await tx`SELECT id FROM opening_knowledge_confirmations WHERE course_id=${courseId}`).toHaveLength(0);
      const [changed] = await tx`SELECT version FROM opening_course_knowledge WHERE course_id=${courseId}`;
      expect(Number(changed!.version)).toBe(confirmed.version + 1);
      await tx`SELECT 1 / 0`;
    })).rejects.toMatchObject({ code: "22012" });
    expect(await repo.get(f.scope, courseId)).toEqual(confirmed);
    expect(await f.sql`SELECT * FROM opening_knowledge_confirmations WHERE course_id=${courseId}`).toEqual(receipts);
  });

  it("rolls back the status/version when the confirmation insert fails", async () => {
    const { repo, courseId, nodeId, record, chunkId } = await pending();
    // Force the insert to fail at the database unique constraint, after the graph UPDATE.
    await f.sql`INSERT INTO opening_knowledge_confirmations
      (id,workspace_id,owner_user_id,course_id,node_id,node_label,node_kind,graph_version_before,graph_version_after,source_versions,evidence_chunk_ids)
      VALUES(${randomUUID()},${f.scope.workspaceId},${f.scope.ownerUserId},${courseId},${nodeId},'函数','concept',1,2,
        ${f.sql.json(record.sourceVersions)},${f.sql.json([chunkId])})`;
    await expect(repo.confirmNode(f.scope, courseId, nodeId, { expectedVersion: 1, sourceVersions: record.sourceVersions }))
      .rejects.toMatchObject({ code: "23505" });
    expect(await repo.get(f.scope, courseId)).toEqual(record);
  });

  it.each(["unchanged", "version", "evidence"])("rebuild keeps only the exact confirmed source and evidence set: %s", async change => {
    const { repo, courseId, nodeId, record, sourceId, chunkId } = await pending();
    await repo.confirmNode(f.scope, courseId, nodeId, { expectedVersion: 1, sourceVersions: record.sourceVersions });
    const snapshot = structuredClone(record.snapshot), sourceVersions = { ...record.sourceVersions };
    if (change === "version") {
      await f.sql`UPDATE opening_sources SET version=2 WHERE id=${sourceId}`;
      await f.sql`INSERT INTO opening_source_versions(source_id,version,workspace_id,bytes,sha256,availability)
        SELECT id,version,workspace_id,bytes,sha256,'available' FROM opening_sources WHERE id=${sourceId}`;
      await f.sql`UPDATE opening_source_chunks SET source_version=2 WHERE id=${chunkId}`;
      sourceVersions[sourceId] = 2;
    }
    if (change === "evidence") {
      const replacement = randomUUID();
      await f.sql`UPDATE opening_source_chunks SET id=${replacement} WHERE id=${chunkId}`;
      snapshot.nodes.forEach(node => { node.evidenceChunkIds = [replacement]; });
      snapshot.edges.forEach(edge => { edge.evidenceChunkIds = [replacement]; });
    }
    const result = await repo.replace(f.scope, courseId, { expectedVersion: 2, expectedReferencedNodeIds: [], snapshot, sourceVersions });
    expect(result.snapshot.nodes[0]!.status).toBe(change === "unchanged" ? "supported" : "needs_check");
    expect(result.snapshot.nodes[1]!.status).toBe("supported");
    expect(result.snapshot.edges).toEqual(snapshot.edges);
  });

  it.each(["needs_check", "suggested"] as const)("preserves the original receipt and supported readback after worker status-only %s classification", async status => {
    const { repo, courseId, nodeId, record } = await pending();
    const confirmed = await repo.confirmNode(f.scope, courseId, nodeId,
      { expectedVersion: record.version, sourceVersions: record.sourceVersions });
    const receipts = await f.sql`SELECT * FROM opening_knowledge_confirmations WHERE course_id=${courseId}`;
    expect(receipts).toHaveLength(1);
    const draft = structuredClone(confirmed.snapshot);
    draft.nodes.find(node => node.id === nodeId)!.status = status;
    const rebuilt = await repo.replace(f.scope, courseId, { expectedVersion: confirmed.version,
      expectedReferencedNodeIds: [], snapshot: draft, sourceVersions: confirmed.sourceVersions });
    expect(rebuilt.version).toBe(confirmed.version + 1);
    expect(rebuilt.snapshot.nodes).toEqual(confirmed.snapshot.nodes);
    expect(rebuilt.snapshot.edges).toEqual(confirmed.snapshot.edges);
    expect(rebuilt.sourceVersions).toEqual(confirmed.sourceVersions);
    expect(await repo.get(f.scope, courseId)).toEqual(rebuilt);
    // Includes the same receipt UUID and original confirmation versions/time: no delete/reinsert.
    expect(await f.sql`SELECT * FROM opening_knowledge_confirmations WHERE course_id=${courseId}`).toEqual(receipts);
  });

  it("withdraws the confirmation when the node is removed; re-adding the same UUID needs a new check", async () => {
    const { repo, courseId, nodeId, record } = await pending();
    const confirmed = await repo.confirmNode(f.scope, courseId, nodeId, { expectedVersion: 1, sourceVersions: record.sourceVersions });
    const without = structuredClone(confirmed.snapshot);
    without.nodes = without.nodes.filter(node => node.id !== nodeId);
    without.edges = without.edges.filter(edge => edge.from !== nodeId && edge.to !== nodeId);
    await repo.replace(f.scope, courseId, { expectedVersion: 2, snapshot: without, sourceVersions: record.sourceVersions });
    expect(await f.sql`SELECT id FROM opening_knowledge_confirmations WHERE course_id=${courseId}`).toHaveLength(0);
    await repo.replace(f.scope, courseId, { expectedVersion: 3, snapshot: structuredClone(record.snapshot), sourceVersions: record.sourceVersions });
    const rebuilt = await repo.replace(f.scope, courseId, { expectedVersion: 4, expectedReferencedNodeIds: [],
      snapshot: structuredClone(record.snapshot), sourceVersions: record.sourceVersions });
    expect(rebuilt.snapshot.nodes.find(node => node.id === nodeId)!.status).toBe("needs_check");
    expect(await f.sql`SELECT id FROM opening_knowledge_confirmations WHERE course_id=${courseId}`).toHaveLength(0);
  });

  it("permanently revokes a confirmation on a semantic graph edit even when the original graph returns", async () => {
    const { repo, courseId, nodeId, record } = await pending();
    const confirmed = await repo.confirmNode(f.scope, courseId, nodeId,
      { expectedVersion: record.version, sourceVersions: record.sourceVersions });
    const changed = structuredClone(confirmed.snapshot);
    changed.edges = [];
    const edited = await repo.replace(f.scope, courseId, { expectedVersion: confirmed.version,
      snapshot: changed, sourceVersions: confirmed.sourceVersions });
    expect(edited.snapshot.nodes.find(node => node.id === nodeId)!.status).toBe("needs_check");
    expect(await f.sql`SELECT id FROM opening_knowledge_confirmations WHERE course_id=${courseId}`).toHaveLength(0);
    const returned = await repo.replace(f.scope, courseId, { expectedVersion: edited.version,
      expectedReferencedNodeIds: [], snapshot: structuredClone(confirmed.snapshot), sourceVersions: confirmed.sourceVersions });
    expect(returned.snapshot.edges).toEqual(confirmed.snapshot.edges);
    expect(returned.snapshot.nodes.find(node => node.id === nodeId)!.status).toBe("needs_check");
    expect(await f.sql`SELECT id FROM opening_knowledge_confirmations WHERE course_id=${courseId}`).toHaveLength(0);
    const checked = await repo.confirmNode(f.scope, courseId, nodeId,
      { expectedVersion: returned.version, sourceVersions: returned.sourceVersions });
    expect(await f.sql`SELECT graph_version_after FROM opening_knowledge_confirmations WHERE course_id=${courseId}`)
      .toEqual([{ graph_version_after: checked.version }]);
  });

  it.each(["needs_check", "suggested"] as const)("withdraws the confirmation when a manual edit moves the node to %s", async status => {
    const { repo, courseId, nodeId, record } = await pending();
    const confirmed = await repo.confirmNode(f.scope, courseId, nodeId, { expectedVersion: 1, sourceVersions: record.sourceVersions });
    const reverted = structuredClone(confirmed.snapshot);
    reverted.nodes.find(node => node.id === nodeId)!.status = status;
    await repo.replace(f.scope, courseId, { expectedVersion: 2, snapshot: reverted, sourceVersions: record.sourceVersions });
    expect(await f.sql`SELECT id FROM opening_knowledge_confirmations WHERE course_id=${courseId}`).toHaveLength(0);
    expect((await repo.get(f.scope, courseId))!.snapshot.nodes.find(node => node.id === nodeId)!.status).toBe(status);
    // Worker status-only rebuild must not resurrect a manually withdrawn receipt.
    const draft = structuredClone(record.snapshot);
    draft.nodes.find(node => node.id === nodeId)!.status = status;
    const rebuilt = await repo.replace(f.scope, courseId, { expectedVersion: 3, expectedReferencedNodeIds: [],
      snapshot: draft, sourceVersions: record.sourceVersions });
    expect(rebuilt.snapshot.nodes.find(node => node.id === nodeId)!.status).toBe(status);
    expect(await f.sql`SELECT id FROM opening_knowledge_confirmations WHERE course_id=${courseId}`).toHaveLength(0);
    if (status === "needs_check") {
      const checked = await repo.confirmNode(f.scope, courseId, nodeId,
        { expectedVersion: rebuilt.version, sourceVersions: rebuilt.sourceVersions });
      expect(await f.sql`SELECT graph_version_after FROM opening_knowledge_confirmations WHERE course_id=${courseId}`)
        .toEqual([{ graph_version_after: checked.version }]);
    } else {
      await expect(repo.confirmNode(f.scope, courseId, nodeId,
        { expectedVersion: rebuilt.version, sourceVersions: rebuilt.sourceVersions })).rejects.toMatchObject({ code: "CONFLICT" });
      expect(await f.sql`SELECT id FROM opening_knowledge_confirmations WHERE course_id=${courseId}`).toHaveLength(0);
    }
  });

  it("confirms a node whose evidence repeats a chunk id and keeps it through an identical rebuild", async () => {
    const { repo, courseId, nodeId, record, chunkId } = await pending();
    const duplicated = structuredClone(record.snapshot);
    duplicated.nodes.find(node => node.id === nodeId)!.evidenceChunkIds = [chunkId, chunkId];
    await repo.replace(f.scope, courseId, { expectedVersion: 1, snapshot: duplicated, sourceVersions: record.sourceVersions });
    const result = await repo.confirmNode(f.scope, courseId, nodeId, { expectedVersion: 2, sourceVersions: record.sourceVersions });
    expect(result.snapshot.nodes.find(node => node.id === nodeId)!.status).toBe("supported");
    const [audit] = await f.sql`SELECT evidence_chunk_ids,source_versions FROM opening_knowledge_confirmations WHERE course_id=${courseId}`;
    expect(audit).toMatchObject({ evidence_chunk_ids: [chunkId], source_versions: record.sourceVersions });
    const rebuilt = await repo.replace(f.scope, courseId, { expectedVersion: 3, expectedReferencedNodeIds: [],
      snapshot: structuredClone(duplicated), sourceVersions: record.sourceVersions });
    expect(rebuilt.snapshot.nodes.find(node => node.id === nodeId)!.status).toBe("supported");
  });

  it("does not allow the ordinary snapshot write to bypass manual confirmation", async () => {
    const { repo, courseId, record } = await pending();
    const snapshot = structuredClone(record.snapshot); snapshot.nodes[0]!.status = "supported";
    await expect(repo.replace(f.scope, courseId, { expectedVersion: 1, snapshot, sourceVersions: record.sourceVersions }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(await repo.get(f.scope, courseId)).toEqual(record);
  });
});

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
