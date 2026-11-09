import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  createExplorationRepository,
  ExplorationRepositoryError,
  createSqlClient,
  lockWorkspaceLearningHistory,
  type ExplorationRepository,
} from "@aistudy/database";
import type { TransactionSql } from "postgres";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for exploration repository tests");

const ownerA = randomUUID();
const ownerB = randomUUID();
const workspaceA = randomUUID();
const workspaceB = randomUUID();

describe("exploration repository", () => {
  const sql = createSqlClient(databaseUrl);
  let repository: ExplorationRepository;

  beforeAll(async () => {
    await applyMigrations(sql);
    repository = createExplorationRepository(sql);
  });

  beforeEach(async () => {
    await sql`TRUNCATE opening_workspace_history_revisions, exploration_blocks, exploration_branches, explorations, course_asset_memberships, courses, sessions, workspaces, users RESTART IDENTITY CASCADE`;
    await sql`INSERT INTO users (id, email, display_name, password_hash) VALUES (${ownerA}, ${`owner-${randomUUID()}@example.com`}, 'Owner A', 'test'), (${ownerB}, ${`owner-${randomUUID()}@example.com`}, 'Owner B', 'test')`;
    await sql`INSERT INTO workspaces (id, owner_user_id) VALUES (${workspaceA}, ${ownerA}), (${workspaceB}, ${ownerB})`;
  });

  afterAll(async () => sql.end({ timeout: 5 }));

  async function history() {
    const rows = await sql`SELECT owner_user_id,revision FROM opening_workspace_history_revisions WHERE workspace_id=${workspaceA}`;
    return rows.map(row => ({ ownerUserId: row.owner_user_id as string, revision: Number(row.revision) }));
  }

  it("creates a goal-free exploration with one stable root branch", async () => {
    const created = await repository.createExploration({
      workspaceId: workspaceA,
      ownerUserId: ownerA,
      title: "Understand queues",
    });
    const detail = await repository.getExploration({ workspaceId: workspaceA, explorationId: created.id });

    expect(created.courseId).toBeNull();
    expect(created.goalId).toBeNull();
    expect(detail.branches).toHaveLength(1);
    expect(detail.branches[0]).toMatchObject({ explorationId: created.id, parentBranchId: null });
    expect(await history()).toEqual([{ ownerUserId: ownerA, revision: 0 }]);
  });

  it.each(["lazy", "nonzero", "other-workspace"] as const)("waits for %s history before creating the root graph", async mode => {
    const explorationId = randomUUID(), courseId = randomUUID(), goalId = randomUUID();
    await sql`INSERT INTO courses (id,workspace_id,title,slug) VALUES (${courseId},${workspaceA},'Course','course')`;
    if (mode !== "lazy") await sql`INSERT INTO opening_workspace_history_revisions(workspace_id,owner_user_id,revision)
      VALUES (${workspaceA},${ownerA},19)`;
    const before = {
      workspace: await sql`SELECT * FROM workspaces WHERE id=${workspaceA}`,
      explorations: await sql`SELECT * FROM explorations WHERE workspace_id=${workspaceA}`,
      branches: await sql`SELECT * FROM exploration_branches WHERE workspace_id=${workspaceA}`,
    };
    const holder = createSqlClient(databaseUrl!, { max: 1 });
    const writer = createSqlClient(databaseUrl!, { max: 1 });
    let release!: () => void, ready!: (tx: TransactionSql) => void, failed!: (error: unknown) => void;
    const proceed = new Promise<void>(resolve => { release = resolve; });
    const opened = new Promise<TransactionSql>((resolve, reject) => { ready = resolve; failed = reject; });
    const holderPid = Number((await holder`SELECT pg_backend_pid() AS pid`)[0]!.pid);
    const writerPid = Number((await writer`SELECT pg_backend_pid() AS pid`)[0]!.pid);
    const held = holder.begin(async tx => {
      await lockWorkspaceLearningHistory(tx, mode === "other-workspace"
        ? { workspaceId: workspaceB, ownerUserId: ownerB }
        : { workspaceId: workspaceA, ownerUserId: ownerA });
      ready(tx);
      await proceed;
    });
    held.catch(failed);
    let result: ReturnType<ExplorationRepository["createExploration"]> | undefined;
    let settled = false;
    const started = new Date();
    try {
      const holderTx = await opened;
      result = createExplorationRepository(writer).createExploration({ workspaceId: workspaceA,
        ownerUserId: ownerA, explorationId, courseId, goalId, title: "  Root graph  " });
      result.then(() => { settled = true; }, () => { settled = true; });
      if (mode !== "other-workspace") {
        let blocked = false;
        const deadline = Date.now() + 2000;
        do {
          const waits = await sql`SELECT a.query FROM pg_stat_activity a WHERE a.pid=${writerPid}
            AND ${holderPid} = ANY(pg_blocking_pids(a.pid))
            AND EXISTS (SELECT 1 FROM pg_locks l WHERE l.pid=a.pid AND NOT l.granted)`;
          if (waits.length) {
            expect(waits[0]!.query).toContain("opening_workspace_history_revisions");
            blocked = true;
            break;
          }
        } while (!settled && Date.now() < deadline);
        expect(blocked, "create must reach the real PostgreSQL history barrier before completing").toBe(true);
        // The holder can lock the workspace: the writer took no early business row lock.
        expect(await holderTx`SELECT id FROM workspaces WHERE id=${workspaceA} FOR UPDATE NOWAIT`).toHaveLength(1);
        expect(await sql`SELECT * FROM workspaces WHERE id=${workspaceA}`).toEqual(before.workspace);
        expect(await sql`SELECT * FROM explorations WHERE workspace_id=${workspaceA}`).toEqual(before.explorations);
        expect(await sql`SELECT * FROM exploration_branches WHERE workspace_id=${workspaceA}`).toEqual(before.branches);
        console.info("exploration history barrier observed", { mode, start: started.toISOString(), observed: new Date().toISOString() });
        release();
        await held;
      }
      // An unrelated workspace's holder must not delay completion.
      const created = await result;
      expect(created).toMatchObject({ id: explorationId, workspaceId: workspaceA, ownerUserId: ownerA,
        courseId, goalId, title: "Root graph", status: "open", closedAt: null });
      expect(created.rootBranch).toMatchObject({ workspaceId: workspaceA, explorationId,
        parentBranchId: null, title: "Root" });
      const detail = await repository.getExploration({ workspaceId: workspaceA, explorationId });
      expect(detail).toEqual({ exploration: created, branches: [created.rootBranch], blocks: [] });
      expect(await sql`SELECT id,owner_user_id,course_id FROM explorations WHERE workspace_id=${workspaceA}`)
        .toEqual([{ id: explorationId, owner_user_id: ownerA, course_id: courseId }]);
      expect(await sql`SELECT id,exploration_id,parent_branch_id FROM exploration_branches WHERE workspace_id=${workspaceA}`)
        .toEqual([{ id: created.rootBranch.id, exploration_id: explorationId, parent_branch_id: null }]);
      expect(await history()).toEqual([{ ownerUserId: ownerA, revision: mode === "lazy" ? 0 : 19 }]);
      expect(await sql`SELECT * FROM workspaces WHERE id=${workspaceA}`).toEqual(before.workspace);
    } finally {
      release();
      await Promise.allSettled([held, ...(result ? [result] : [])]);
      await Promise.all([holder.end({ timeout: 5 }), writer.end({ timeout: 5 })]);
      console.info("exploration history barrier end", { mode, start: started.toISOString(), end: new Date().toISOString() });
    }
  });

  it.each([null, 19])("rolls back both inserts and history initialization at revision %s when root insert fails", async revision => {
    if (revision !== null) await sql`INSERT INTO opening_workspace_history_revisions(workspace_id,owner_user_id,revision)
      VALUES (${workspaceA},${ownerA},${revision})`;
    await sql.unsafe(`CREATE FUNCTION fail_exploration_root() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected root insert failure' USING ERRCODE='23514'; END $$`);
    try {
      await sql.unsafe(`CREATE TRIGGER fail_exploration_root BEFORE INSERT ON exploration_branches
        FOR EACH ROW EXECUTE FUNCTION fail_exploration_root()`);
      await expect(repository.createExploration({ workspaceId: workspaceA, ownerUserId: ownerA, title: "Rollback" }))
        .rejects.toMatchObject({ code: "23514", message: "injected root insert failure" });
      expect(await sql`SELECT id FROM explorations`).toEqual([]);
      expect(await sql`SELECT id FROM exploration_branches`).toEqual([]);
      expect(await history()).toEqual(revision === null ? [] : [{ ownerUserId: ownerA, revision }]);
    } finally {
      await sql.unsafe("DROP TRIGGER IF EXISTS fail_exploration_root ON exploration_branches");
      await sql.unsafe("DROP FUNCTION fail_exploration_root()");
    }
  });

  it.each(["owner-move", "workspace-delete"] as const)("uses the transaction's DB owner after a %s at the validation boundary", async race => {
    const nextOwner = randomUUID();
    await sql`INSERT INTO users (id,email,display_name,password_hash)
      VALUES (${nextOwner},${`${nextOwner}@example.com`},'Next owner','test')`;
    // Interleave real committed SQL after the unchanged validation prefix and
    // before begin; do not replace the transaction or its database queries.
    const racedSql = new Proxy(sql, {
      get(target, key, receiver) {
        if (key === "begin") return async (callback: (tx: TransactionSql) => Promise<void>) => {
          if (race === "owner-move") await sql`UPDATE workspaces SET owner_user_id=${nextOwner} WHERE id=${workspaceA}`;
          else await sql`DELETE FROM workspaces WHERE id=${workspaceA}`;
          return target.begin(callback);
        };
        return Reflect.get(target, key, receiver);
      },
    });
    const result = createExplorationRepository(racedSql).createExploration({
      workspaceId: workspaceA, ownerUserId: ownerA, title: "Boundary race",
    });
    if (race === "workspace-delete") {
      await expect(result).rejects.toBeInstanceOf(ExplorationRepositoryError);
      await expect(result).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(await history()).toEqual([]);
      expect(await sql`SELECT id FROM explorations`).toEqual([]);
      expect(await sql`SELECT id FROM exploration_branches`).toEqual([]);
    } else {
      const created = await result;
      // History identity follows the DB owner, not the already-validated input.
      // Original insert semantics still retain the input owner on the graph.
      expect(created.ownerUserId).toBe(ownerA);
      expect(await history()).toEqual([{ ownerUserId: nextOwner, revision: 0 }]);
      const detail = await repository.getExploration({ workspaceId: workspaceA, explorationId: created.id });
      expect(detail).toEqual({ exploration: created, branches: [created.rootBranch], blocks: [] });
    }
  });

  it("preserves the validation prefix without creating history or a root graph", async () => {
    const foreignCourse = randomUUID();
    await sql`INSERT INTO courses (id,workspace_id,title,slug) VALUES (${foreignCourse},${workspaceB},'Other','other')`;
    const valid = { workspaceId: workspaceA, ownerUserId: ownerA, title: "Valid" };
    const cases = [
      [{ title: " ", workspaceId: "invalid" }, "VALIDATION"],
      [{ workspaceId: "invalid" }, "VALIDATION"],
      [{ workspaceId: randomUUID(), ownerUserId: "invalid" }, "NOT_FOUND"],
      [{ ownerUserId: "invalid" }, "VALIDATION"],
      [{ ownerUserId: ownerB, courseId: "invalid" }, "WORKSPACE_MISMATCH"],
      [{ courseId: "invalid", goalId: "invalid" }, "VALIDATION"],
      [{ courseId: randomUUID(), goalId: "invalid" }, "NOT_FOUND"],
      [{ courseId: foreignCourse, goalId: "invalid" }, "WORKSPACE_MISMATCH"],
      [{ goalId: "invalid", explorationId: "invalid" }, "VALIDATION"],
      [{ explorationId: "invalid" }, "VALIDATION"],
    ] as const;
    for (const [input, code] of cases) {
      await expect(repository.createExploration({ ...valid, ...input })).rejects.toMatchObject({ code });
    }
    expect(await sql`SELECT id FROM explorations`).toEqual([]);
    expect(await sql`SELECT id FROM exploration_branches`).toEqual([]);
    expect(await sql`SELECT * FROM opening_workspace_history_revisions`).toEqual([]);
  });

  it("persists all block kinds and creates branches without copying parent blocks", async () => {
    const exploration = await repository.createExploration({ workspaceId: workspaceA, ownerUserId: ownerA, title: "Branch test" });
    const root = exploration.rootBranch;
    await repository.createBlock({ workspaceId: workspaceA, explorationId: exploration.id, branchId: root.id, kind: "scratch", content: "scratch", position: 0 });
    await repository.createBlock({ workspaceId: workspaceA, explorationId: exploration.id, branchId: root.id, kind: "hypothesis", content: "hypothesis", position: 1 });
    await repository.createBlock({ workspaceId: workspaceA, explorationId: exploration.id, branchId: root.id, kind: "open_question", content: "question", position: 2 });
    const branch = await repository.createBranch({ workspaceId: workspaceA, explorationId: exploration.id, parentBranchId: root.id, title: "Alternative" });
    const detail = await repository.getExploration({ workspaceId: workspaceA, explorationId: exploration.id });

    expect(branch.parentBranchId).toBe(root.id);
    expect(detail.branches).toHaveLength(2);
    expect(detail.blocks).toHaveLength(3);
    expect(detail.blocks.every((block) => block.branchId === root.id)).toBe(true);
  });

  it("supports close and resume while rejecting invalid content and cross-workspace access", async () => {
    const exploration = await repository.createExploration({ workspaceId: workspaceA, ownerUserId: ownerA, title: "Lifecycle" });
    await expect(repository.createBlock({ workspaceId: workspaceA, explorationId: exploration.id, branchId: exploration.rootBranch.id, kind: "scratch", content: " ", position: 0 })).rejects.toMatchObject({ code: "VALIDATION" });
    const closed = await repository.setStatus({ workspaceId: workspaceA, explorationId: exploration.id, status: "closed" });
    expect(closed.status).toBe("closed");
    await expect(repository.createBlock({ workspaceId: workspaceA, explorationId: exploration.id, branchId: exploration.rootBranch.id, kind: "scratch", content: "blocked while closed" })).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    await expect(repository.createBranch({ workspaceId: workspaceA, explorationId: exploration.id, parentBranchId: exploration.rootBranch.id, title: "Blocked" })).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    const resumed = await repository.setStatus({ workspaceId: workspaceA, explorationId: exploration.id, status: "open" });
    expect(resumed.status).toBe("open");
    await expect(repository.listExplorations({ workspaceId: workspaceB })).resolves.toEqual([]);
    await expect(repository.getExploration({ workspaceId: workspaceB, explorationId: exploration.id })).rejects.toMatchObject({ code: "WORKSPACE_MISMATCH" });
    await expect(repository.createBranch({ workspaceId: workspaceB, explorationId: exploration.id, title: "Denied" })).rejects.toMatchObject({ code: "WORKSPACE_MISMATCH" });
    await expect(repository.setStatus({ workspaceId: workspaceB, explorationId: exploration.id, status: "closed" })).rejects.toMatchObject({ code: "WORKSPACE_MISMATCH" });
  });
});
