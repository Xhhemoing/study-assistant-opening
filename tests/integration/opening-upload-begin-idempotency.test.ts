import { randomUUID } from "node:crypto";
import type { TransactionSql } from "postgres";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOpeningSourceActionsRepository, createOpeningSourceRepository, OpeningSourceError } from "@aistudy/database";
import { lockWorkspaceLearningHistory } from "../../packages/database/src/repositories/opening-learning-facts";
import { openRaceSession } from "./opening-race-helpers";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

let f: OpeningFixture;
beforeEach(async () => { f = await createOpeningFixture(); });
afterEach(async () => { await f?.close(); });
const input = (uploadId = randomUUID()) => ({ uploadId, name: "same.pdf", mime: "application/pdf" as const, bytes: 4, sha256: "a".repeat(64) });

describe("begin upload operation identity with real SQL", () => {
  it.each([
    { mode: "lazy", uploadId: true }, { mode: "nonzero", uploadId: true },
    { mode: "replay", uploadId: true }, { mode: "other-workspace", uploadId: true },
    { mode: "lazy", uploadId: false }, { mode: "nonzero", uploadId: false },
    { mode: "other-workspace", uploadId: false },
  ])("history barrier before business locks: $mode, uploadId=$uploadId", async ({ mode, uploadId }) => {
    const oldId = randomUUID(), chunkId = randomUUID(), courseId = randomUUID(), nodeId = randomUUID();
    await f.sql`INSERT INTO opening_sources(id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state)
      VALUES(${oldId},${f.scope.workspaceId},'old.pdf','application/pdf',4,${"b".repeat(64)},1,'uploaded','ready')`;
    await f.sql`INSERT INTO opening_source_chunks(id,source_id,source_version,page,text)
      VALUES(${chunkId},${oldId},1,1,'old evidence')`;
    await f.sql`INSERT INTO opening_source_versions(source_id,version,workspace_id,bytes,sha256,availability)
      VALUES(${oldId},1,${f.scope.workspaceId},4,${"b".repeat(64)},'available')`;
    await f.sql`INSERT INTO courses(id,workspace_id,title,slug)
      VALUES(${courseId},${f.scope.workspaceId},'Old graph',${courseId})`;
    await f.sql`INSERT INTO course_asset_memberships(id,workspace_id,course_id,asset_type,asset_id,role,sort_order,visibility)
      VALUES(${randomUUID()},${f.scope.workspaceId},${courseId},'source',${oldId},'core',0,'course')`;
    const snapshot = { courseId, version: 1, nodes: [{ id: nodeId, courseId, label: 'Old concept', kind: 'concept',
      evidenceChunkIds: [chunkId], status: 'supported' }], edges: [] };
    await f.sql`INSERT INTO opening_course_knowledge(workspace_id,owner_user_id,course_id,version,snapshot,source_versions)
      VALUES(${f.scope.workspaceId},${f.scope.ownerUserId},${courseId},1,${f.sql.json(snapshot)},${f.sql.json({ [oldId]: 1 })})`;
    const { uploadId: identity, ...plain } = input();
    const operation = uploadId ? { ...plain, uploadId: identity } : plain;
    const quota = { maxBytes: mode === "replay" ? 8 : 12, maxObjects: mode === "replay" ? 2 : 3 };
    const repo = createOpeningSourceRepository(f.sql, { quota });
    if (mode === "replay") await repo.create(f.scope, operation);
    if (mode !== "lazy") {
      await f.sql.begin(tx => lockWorkspaceLearningHistory(tx, f.scope));
      await f.sql`UPDATE opening_workspace_history_revisions SET revision=19 WHERE workspace_id=${f.scope.workspaceId}`;
    }
    const state = async () => ({
      workspace: await f.sql`SELECT * FROM workspaces WHERE id=${f.scope.workspaceId}`,
      sources: await f.sql`SELECT * FROM opening_sources WHERE workspace_id=${f.scope.workspaceId} ORDER BY id`,
      versions: await f.sql`SELECT * FROM opening_source_versions WHERE workspace_id=${f.scope.workspaceId} ORDER BY source_id,version`,
      chunks: await f.sql`SELECT * FROM opening_source_chunks WHERE source_id=${oldId}`,
      graph: await f.sql`SELECT * FROM opening_course_knowledge WHERE course_id=${courseId}`,
    });
    const before = await state();
    const holder = openRaceSession(), writer = openRaceSession();
    let release!: () => void;
    const proceed = new Promise<void>(resolve => { release = resolve; });
    let ready!: (tx: TransactionSql) => void, failed!: (error: unknown) => void;
    const opened = new Promise<TransactionSql>((resolve, reject) => { ready = resolve; failed = reject; });
    let holding: Promise<unknown> | undefined, writing: ReturnType<typeof repo.create> | undefined;
    try {
      await Promise.all([holder.ready, writer.ready]);
      holding = holder.sql.begin(async tx => {
        await lockWorkspaceLearningHistory(tx, mode === "other-workspace" ? f.otherScope : f.scope);
        ready(tx);
        await proceed;
      });
      holding.catch(failed);
      const tx = await opened;
      let settled = false;
      writing = createOpeningSourceRepository(writer.sql, { quota }).create(f.scope, operation);
      writing.then(() => { settled = true; }, () => { settled = true; });
      if (mode !== "other-workspace") {
        let blocked = false;
        const deadline = Date.now() + 1500;
        do {
          const [wait] = await f.sql`SELECT a.query FROM pg_stat_activity a WHERE a.pid=${writer.pid}
            AND ${holder.pid}=ANY(pg_blocking_pids(a.pid))
            AND EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=a.pid AND NOT l.granted)`;
          if (wait) {
            expect(wait.query).toContain("opening_workspace_history_revisions");
            blocked = true;
            break;
          }
        } while (!settled && Date.now() < deadline);
        expect(blocked, "create must block on the real history row before business locks").toBe(true);
        await tx`SELECT id FROM workspaces WHERE id=${f.scope.workspaceId} FOR UPDATE NOWAIT`;
        await tx`SELECT id FROM opening_sources WHERE workspace_id=${f.scope.workspaceId} FOR UPDATE NOWAIT`;
        expect(await state()).toEqual(before);
        console.info("source create history barrier", { mode, uploadId, ungranted: true, blockedByHolder: true });
        release();
        await holding;
      }
      const created = await writing;
      expect(created).toMatchObject({ workspaceId: f.scope.workspaceId, uploadState: "pending", parseState: "not_started", version: 0 });
      if (uploadId) expect(created.id).toBe(identity);
      expect(await f.sql`SELECT revision::int AS revision FROM opening_workspace_history_revisions WHERE workspace_id=${f.scope.workspaceId}`)
        .toEqual([{ revision: mode === "lazy" ? 0 : 19 }]);
      const after = await state();
      expect({ ...after, sources: before.sources }).toEqual(before);
      expect(after.sources).toHaveLength(2);
      expect(after.sources.find(row => row.id === oldId)).toEqual(before.sources.find(row => row.id === oldId));
    } finally {
      release();
      await Promise.allSettled([holding, writing].filter(Boolean));
      await Promise.all([holder.sql.end({ timeout: 5 }), writer.sql.end({ timeout: 5 })]);
    }
  });

  it("replays concurrent same-owner starts once even at the object and byte quota", async () => {
    const repo = createOpeningSourceRepository(f.sql, { quota: { maxBytes: 4, maxObjects: 1 } });
    const operation = input();
    const [first, repeated] = await Promise.all([repo.create(f.scope, operation), repo.create(f.scope, operation)]);
    expect(first.id).toBe(operation.uploadId);
    expect(repeated).toEqual(first);
    expect(await f.sql`SELECT id FROM opening_sources WHERE workspace_id=${f.scope.workspaceId}`).toEqual([{ id: first.id }]);
  });

  it.each([
    { name: "changed.pdf" }, { mime: "text/plain" as const }, { bytes: 3 }, { sha256: "b".repeat(64) },
  ])("rejects reuse with changed original metadata %j", async changed => {
    const repo = createOpeningSourceRepository(f.sql), operation = input();
    await repo.create(f.scope, operation);
    await expect(repo.create(f.scope, { ...operation, ...changed })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await f.sql`SELECT id,name,mime,bytes,sha256 FROM opening_sources WHERE id=${operation.uploadId}`)
      .toEqual([{ id: operation.uploadId, name: operation.name, mime: operation.mime, bytes: operation.bytes, sha256: operation.sha256 }]);
  });

  it("keeps intentional uploads separate and never rebinds an identity to another owner", async () => {
    const repo = createOpeningSourceRepository(f.sql), operation = input();
    const first = await repo.create(f.scope, operation);
    await expect(repo.create(f.otherScope, operation)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const wrongOwner = repo.create({ ...f.scope, ownerUserId: f.otherScope.ownerUserId }, operation);
    await expect(wrongOwner).rejects.toBeInstanceOf(OpeningSourceError);
    await expect(wrongOwner).rejects.toMatchObject({ code: "NOT_FOUND", message: "Upload operation unavailable" });
    const second = await repo.create(f.scope, { ...operation, uploadId: randomUUID() });
    expect(second.id).not.toBe(first.id);
    expect(await f.sql`SELECT id FROM opening_sources WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(2);
  });

  it.each(["exclude", "delete"] as const)("never revives an identity after %s, including from a different workspace", async action => {
    const repo = createOpeningSourceRepository(f.sql), operation = input();
    const source = await repo.create(f.scope, operation);
    await createOpeningSourceActionsRepository(f.sql).apply(f.scope, source.id,
      { action, expectedVersion: 0, expectedMembershipIds: [] },
      { stagingKey: id => `opening/staging/${id}`, finalKey: (id, version) => `opening/sources/${id}/v${version}` }, new Date());
    await expect(repo.create(f.scope, operation)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(repo.create(f.otherScope, operation)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await f.sql`SELECT id FROM opening_sources WHERE id=${source.id}`).toHaveLength(action === "delete" ? 0 : 1);
  });

  it("rejects a historical orphan identity instead of attaching its old references to a new upload", async () => {
    const operation = input();
    await f.sql`INSERT INTO opening_source_versions(source_id,version,workspace_id,bytes,sha256,availability)
      VALUES(${operation.uploadId},0,${f.scope.workspaceId},4,${operation.sha256},'unavailable')`;
    await expect(createOpeningSourceRepository(f.sql).create(f.otherScope, operation)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await f.sql`SELECT id FROM opening_sources WHERE id=${operation.uploadId}`).toEqual([]);
  });
});
