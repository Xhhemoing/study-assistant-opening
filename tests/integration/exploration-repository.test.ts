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

  async function statusGraph(explorationId: string) {
    return {
      workspace: await sql`SELECT * FROM workspaces WHERE id=${workspaceA}`,
      explorations: await sql`SELECT * FROM explorations WHERE id=${explorationId}`,
      branches: await sql`SELECT * FROM exploration_branches WHERE exploration_id=${explorationId} ORDER BY id`,
      blocks: await sql`SELECT * FROM exploration_blocks WHERE exploration_id=${explorationId} ORDER BY id`,
    };
  }

  async function prepareStatusGraph(status: "open" | "closed") {
    const created = await repository.createExploration({ workspaceId: workspaceA, ownerUserId: ownerA, title: "Status graph" });
    const branch = await repository.createBranch({ workspaceId: workspaceA, explorationId: created.id,
      parentBranchId: created.rootBranch.id, title: "Child" });
    await repository.createBlock({ workspaceId: workspaceA, explorationId: created.id, branchId: branch.id,
      kind: "scratch", content: "Retained content" });
    await sql`UPDATE explorations SET status=${status}, updated_at='2020-01-02T00:00:00Z',
      closed_at=${status === "closed" ? new Date("2020-01-01T00:00:00Z") : null} WHERE id=${created.id}`;
    return created.id;
  }

  describe.each(["createBranch", "createBlock"] as const)("%s content history", method => {
    async function write(repo: ExplorationRepository, explorationId: string, branchId: string, id: string = randomUUID()) {
      return method === "createBranch"
        ? repo.createBranch({ workspaceId: workspaceA, explorationId, parentBranchId: branchId, branchId: id, title: "  New child  " })
        : repo.createBlock({ workspaceId: workspaceA, explorationId, branchId, blockId: id, kind: "hypothesis", content: "  New content  " });
    }

    it.each(["lazy", "nonzero", "other-workspace"] as const)("waits for %s content history before either write", async mode => {
      // The base already fences root creation: seed a nonempty graph before the holder.
      const explorationId = await prepareStatusGraph("open");
      if (mode === "lazy") await sql`DELETE FROM opening_workspace_history_revisions WHERE workspace_id=${workspaceA}`;
      if (mode === "nonzero") await sql`UPDATE opening_workspace_history_revisions SET revision=19 WHERE workspace_id=${workspaceA}`;
      const before = await statusGraph(explorationId);
      expect(before.branches).toHaveLength(2);
      expect(before.blocks).toHaveLength(1);
      const branchId = before.blocks[0]!.branch_id as string;
      const id = randomUUID();
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
      let result: ReturnType<typeof write> | undefined;
      let settled = false;
      const started = new Date();
      try {
        const holderTx = await opened;
        result = write(createExplorationRepository(writer), explorationId, branchId, id);
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
          expect(blocked, `${method} must reach the real PostgreSQL history barrier before either business write`).toBe(true);
          expect(await holderTx`SELECT id FROM workspaces WHERE id=${workspaceA} FOR UPDATE NOWAIT`).toHaveLength(1);
          expect(await holderTx`SELECT id FROM explorations WHERE id=${explorationId} FOR UPDATE NOWAIT`).toHaveLength(1);
          expect(await statusGraph(explorationId)).toEqual(before);
          console.info("exploration content history barrier observed", { method, mode, start: started.toISOString(), observed: new Date().toISOString() });
          release();
          await held;
        }
        // Do not release an unrelated workspace holder until this writer finishes.
        const created = await result;
        const after = await statusGraph(explorationId);
        const key = method === "createBranch" ? "branches" : "blocks";
        const inserted = after[key].filter(row => row.id === id);
        expect(inserted).toHaveLength(1);
        const row = inserted[0]!;
        expect(created).toEqual(method === "createBranch"
          ? { id, workspaceId: workspaceA, explorationId, parentBranchId: branchId, title: "New child",
            createdAt: row.created_at, updatedAt: row.updated_at }
          : { id, workspaceId: workspaceA, explorationId, branchId, kind: "hypothesis", content: "New content", position: 1,
            createdAt: row.created_at, updatedAt: row.updated_at });
        expect(after[key]).toHaveLength(before[key].length + 1);
        expect({ ...after, [key]: after[key].filter(row => row.id !== id), explorations: before.explorations }).toEqual(before);
        expect(after.explorations).toEqual([{ ...before.explorations[0], updated_at: after.explorations[0]!.updated_at }]);
        expect(new Date(after.explorations[0]!.updated_at).getTime()).toBeGreaterThan(new Date(before.explorations[0]!.updated_at).getTime());
        expect(await history()).toEqual([{ ownerUserId: ownerA, revision: mode === "nonzero" ? 19 : 0 }]);
      } finally {
        release();
        await Promise.allSettled([held, ...(result ? [result] : [])]);
        await Promise.all([holder.end({ timeout: 5 }), writer.end({ timeout: 5 })]);
        console.info("exploration content history barrier end", { method, mode, start: started.toISOString(), end: new Date().toISOString() });
      }
    });

    it.each([null, 19])("rolls back the INSERT, real second UPDATE and history at revision %s", async revision => {
      const explorationId = await prepareStatusGraph("open");
      if (revision === null) await sql`DELETE FROM opening_workspace_history_revisions WHERE workspace_id=${workspaceA}`;
      else await sql`UPDATE opening_workspace_history_revisions SET revision=${revision} WHERE workspace_id=${workspaceA}`;
      const before = await statusGraph(explorationId);
      const id = randomUUID();
      const fault = new Error("injected after real content timestamp update");
      let updated = false;
      const failingSql = new Proxy(sql, {
        get(target, key, receiver) {
          if (key === "begin") return (callback: (tx: TransactionSql) => Promise<unknown>) => target.begin(tx => callback(new Proxy(tx, {
            async apply(query, thisArg, args) {
              const rows = await Reflect.apply(query, thisArg, args);
              if ((args[0] as TemplateStringsArray).join("").includes("UPDATE explorations SET updated_at")) {
                const inserted = method === "createBranch"
                  ? await tx`SELECT id FROM exploration_branches WHERE id=${id}`
                  : await tx`SELECT id FROM exploration_blocks WHERE id=${id}`;
                expect(inserted).toEqual([{ id }]);
                const changed = await tx`SELECT updated_at FROM explorations WHERE id=${explorationId}`;
                expect(new Date(changed[0]!.updated_at).getTime()).toBeGreaterThan(new Date(before.explorations[0]!.updated_at).getTime());
                const revisions = await tx`SELECT revision FROM opening_workspace_history_revisions WHERE workspace_id=${workspaceA}`;
                expect(revisions.map(row => Number(row.revision))).toEqual([revision ?? 0]);
                updated = true;
                throw fault;
              }
              return rows;
            },
          })));
          return Reflect.get(target, key, receiver);
        },
      });
      await expect(write(createExplorationRepository(failingSql), explorationId, before.blocks[0]!.branch_id as string, id)).rejects.toBe(fault);
      expect(updated).toBe(true);
      expect(await statusGraph(explorationId)).toEqual(before);
      expect(await history()).toEqual(revision === null ? [] : [{ ownerUserId: ownerA, revision }]);
    });

    it.each([null, 19])("keeps 23505 CONFLICT and leaves no extra graph or history at revision %s", async revision => {
      const explorationId = await prepareStatusGraph("open");
      if (revision === null) await sql`DELETE FROM opening_workspace_history_revisions WHERE workspace_id=${workspaceA}`;
      else await sql`UPDATE opening_workspace_history_revisions SET revision=${revision} WHERE workspace_id=${workspaceA}`;
      const before = await statusGraph(explorationId);
      if (method === "createBranch") {
        await expect(write(repository, explorationId, before.blocks[0]!.branch_id as string, before.branches[0]!.id as string))
          .rejects.toMatchObject({ code: "CONFLICT", message: "Branch already exists" });
      } else {
        const valid = { workspaceId: workspaceA, explorationId, branchId: before.blocks[0]!.branch_id as string,
          kind: "scratch" as const, content: "Duplicate" };
        await expect(repository.createBlock({ ...valid, position: 0 })).rejects.toMatchObject({ code: "CONFLICT", message: "Block position already exists" });
        await expect(repository.createBlock({ ...valid, blockId: before.blocks[0]!.id as string })).rejects.toMatchObject({ code: "CONFLICT", message: "Block position already exists" });
      }
      expect(await statusGraph(explorationId)).toEqual(before);
      expect(await history()).toEqual(revision === null ? [] : [{ ownerUserId: ownerA, revision }]);
    });

    it.each(["owner-move", "workspace-delete"] as const)("uses the transaction DB owner after %s without changing graph ownership", async race => {
      const explorationId = await prepareStatusGraph("open");
      const before = await statusGraph(explorationId);
      await sql`DELETE FROM opening_workspace_history_revisions WHERE workspace_id=${workspaceA}`;
      const nextOwner = randomUUID();
      await sql`INSERT INTO users (id,email,display_name,password_hash)
        VALUES (${nextOwner},${`${nextOwner}@example.com`},'Next owner','test')`;
      const racedSql = new Proxy(sql, {
        get(target, key, receiver) {
          if (key === "begin") return async (callback: (tx: TransactionSql) => Promise<unknown>) => {
            if (race === "owner-move") await sql`UPDATE workspaces SET owner_user_id=${nextOwner} WHERE id=${workspaceA}`;
            else await sql`DELETE FROM workspaces WHERE id=${workspaceA}`;
            return target.begin(callback);
          };
          return Reflect.get(target, key, receiver);
        },
      });
      const result = write(createExplorationRepository(racedSql), explorationId, before.blocks[0]!.branch_id as string);
      if (race === "workspace-delete") {
        await expect(result).rejects.toMatchObject({ code: "NOT_FOUND", message: `Workspace not found: ${workspaceA}` });
        expect(await history()).toEqual([]);
        expect(await sql`SELECT id FROM explorations WHERE id=${explorationId}`).toEqual([]);
      } else {
        expect(await result).toMatchObject({ workspaceId: workspaceA, explorationId });
        expect(await history()).toEqual([{ ownerUserId: nextOwner, revision: 0 }]);
        expect(await sql`SELECT owner_user_id FROM explorations WHERE id=${explorationId}`).toEqual([{ owner_user_id: ownerA }]);
      }
    });

    it("preserves the static validation prefix and error priority without graph or history side effects", async () => {
      const explorationId = await prepareStatusGraph("open");
      const foreign = await repository.createExploration({ workspaceId: workspaceB, ownerUserId: ownerB, title: "Foreign" });
      const sibling = await repository.createExploration({ workspaceId: workspaceA, ownerUserId: ownerA, title: "Sibling" });
      await sql`DELETE FROM opening_workspace_history_revisions`;
      const before = await statusGraph(explorationId);
      const branchId = before.blocks[0]!.branch_id as string;
      const common = [
        [{ workspaceId: "invalid", explorationId: "invalid" }, "VALIDATION", "Invalid UUID for workspaceId"],
        [{ workspaceId: randomUUID(), explorationId: "invalid" }, "NOT_FOUND", "Workspace not found:"],
        [{ explorationId: "invalid" }, "VALIDATION", "Invalid UUID for explorationId"],
        [{ explorationId: randomUUID() }, "NOT_FOUND", "Exploration not found:"],
        [{ workspaceId: workspaceB }, "WORKSPACE_MISMATCH", "is not in workspace"],
      ] as const;
      let closedBefore: Awaited<ReturnType<typeof statusGraph>>;
      if (method === "createBranch") {
        const valid = { workspaceId: workspaceA, explorationId, parentBranchId: branchId, title: "Valid" };
        const cases = [
          [{ title: " ", workspaceId: "invalid" }, "VALIDATION", "title must be between"],
          ...common,
          [{ parentBranchId: null, branchId: "invalid" }, "VALIDATION", "Child branches require a parentBranchId"],
          [{ parentBranchId: "invalid", branchId: "invalid" }, "VALIDATION", "Invalid UUID for branchId"],
          [{ parentBranchId: randomUUID(), branchId: "invalid" }, "NOT_FOUND", "Branch not found:"],
          [{ parentBranchId: foreign.rootBranch.id, branchId: "invalid" }, "WORKSPACE_MISMATCH", "is not in the requested exploration workspace"],
          [{ parentBranchId: sibling.rootBranch.id, branchId: "invalid" }, "WORKSPACE_MISMATCH", "is not in the requested exploration workspace"],
          [{ branchId: "invalid" }, "VALIDATION", "Invalid UUID for branchId"],
        ] as const;
        for (const [input, code, message] of cases) {
          await expect(repository.createBranch({ ...valid, ...input })).rejects.toMatchObject({ code, message: expect.stringContaining(message) });
        }
        expect(await statusGraph(explorationId)).toEqual(before);
        await sql`UPDATE explorations SET status='closed', closed_at='2020-01-03T00:00:00Z' WHERE id=${explorationId}`;
        closedBefore = await statusGraph(explorationId);
        await expect(repository.createBranch({ ...valid, parentBranchId: "invalid" })).rejects.toMatchObject({ code: "INVALID_TRANSITION", message: "Closed explorations cannot be modified" });
      } else {
        const valid = { workspaceId: workspaceA, explorationId, branchId, kind: "scratch" as const, content: "Valid" };
        const cases = [
          [{ content: " ", workspaceId: "invalid" }, "VALIDATION", "content must be between"],
          ...common,
          [{ branchId: "invalid", kind: "invalid" }, "VALIDATION", "Invalid UUID for branchId"],
          [{ branchId: randomUUID(), kind: "invalid" }, "NOT_FOUND", "Branch not found:"],
          [{ branchId: foreign.rootBranch.id, kind: "invalid" }, "WORKSPACE_MISMATCH", "is not in the requested exploration workspace"],
          [{ branchId: sibling.rootBranch.id, kind: "invalid" }, "WORKSPACE_MISMATCH", "is not in the requested exploration workspace"],
          [{ kind: "invalid", position: -1, blockId: "invalid" }, "VALIDATION", "Invalid block kind"],
          [{ position: -1, blockId: "invalid" }, "VALIDATION", "Position must be a non-negative integer"],
          [{ position: 0.5, blockId: "invalid" }, "VALIDATION", "Position must be a non-negative integer"],
          [{ blockId: "invalid" }, "VALIDATION", "Invalid UUID for blockId"],
        ] as const;
        for (const [input, code, message] of cases) {
          await expect(repository.createBlock({ ...valid, ...input } as Parameters<ExplorationRepository["createBlock"]>[0]))
            .rejects.toMatchObject({ code, message: expect.stringContaining(message) });
        }
        expect(await statusGraph(explorationId)).toEqual(before);
        await sql`UPDATE explorations SET status='closed', closed_at='2020-01-03T00:00:00Z' WHERE id=${explorationId}`;
        closedBefore = await statusGraph(explorationId);
        await expect(repository.createBlock({ ...valid, branchId: "invalid", kind: "invalid" } as unknown as Parameters<ExplorationRepository["createBlock"]>[0]))
          .rejects.toMatchObject({ code: "INVALID_TRANSITION", message: "Closed explorations cannot be modified" });
      }
      expect(await statusGraph(explorationId)).toEqual(closedBefore);
      expect(await sql`SELECT * FROM opening_workspace_history_revisions`).toEqual([]);
    });
  });

  describe.each(["closed", "open"] as const)("setStatus to %s", status => {
    const previous = status === "closed" ? "open" : "closed";

    it.each(["zero", "nonzero", "other-workspace"] as const)("waits for %s status history before updating the nonempty graph", async mode => {
      // Root creation already initializes history on the parent commit. Prepare it
      // before taking the holder lock, so this barrier isolates setStatus only.
      const explorationId = await prepareStatusGraph(previous);
      if (mode === "nonzero") await sql`UPDATE opening_workspace_history_revisions SET revision=19 WHERE workspace_id=${workspaceA}`;
      const before = await statusGraph(explorationId);
      expect(before.branches).toHaveLength(2);
      expect(before.blocks).toHaveLength(1);
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
      let result: ReturnType<ExplorationRepository["setStatus"]> | undefined;
      let settled = false;
      const started = new Date();
      try {
        const holderTx = await opened;
        result = createExplorationRepository(writer).setStatus({ workspaceId: workspaceA, explorationId, status });
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
          expect(blocked, "setStatus must reach the real PostgreSQL history barrier before completing").toBe(true);
          // Ordinary SELECTs still hold AccessShare relation locks, but must not
          // take workspace/exploration row locks ahead of history.
          expect(await holderTx`SELECT id FROM workspaces WHERE id=${workspaceA} FOR UPDATE NOWAIT`).toHaveLength(1);
          expect(await holderTx`SELECT id FROM explorations WHERE id=${explorationId} FOR UPDATE NOWAIT`).toHaveLength(1);
          expect(await statusGraph(explorationId)).toEqual(before);
          console.info("exploration status history barrier observed", { status, mode, start: started.toISOString(), observed: new Date().toISOString() });
          release();
          await held;
        }
        // A holder in another workspace must not delay the status mutation.
        const changed = await result;
        expect(changed).toMatchObject({ id: explorationId, status });
        expect(changed.updatedAt.getTime()).toBeGreaterThan(new Date(before.explorations[0]!.updated_at).getTime());
        if (status === "closed") expect(changed.closedAt).toEqual(changed.updatedAt);
        else expect(changed.closedAt).toBeNull();
        expect(await statusGraph(explorationId)).toEqual({ ...before, explorations: [{ ...before.explorations[0],
          status, closed_at: changed.closedAt, updated_at: changed.updatedAt }] });
        expect((await repository.getExploration({ workspaceId: workspaceA, explorationId })).exploration).toEqual(changed);
        expect(await history()).toEqual([{ ownerUserId: ownerA, revision: mode === "nonzero" ? 19 : 0 }]);
      } finally {
        release();
        await Promise.allSettled([held, ...(result ? [result] : [])]);
        await Promise.all([holder.end({ timeout: 5 }), writer.end({ timeout: 5 })]);
        console.info("exploration status history barrier end", { status, mode, start: started.toISOString(), end: new Date().toISOString() });
      }
    });

    it("lazily initializes status history at zero without advancing it", async () => {
      const explorationId = await prepareStatusGraph(previous);
      await sql`DELETE FROM opening_workspace_history_revisions WHERE workspace_id=${workspaceA}`;
      const before = await statusGraph(explorationId);
      const changed = await repository.setStatus({ workspaceId: workspaceA, explorationId, status });
      expect(await history()).toEqual([{ ownerUserId: ownerA, revision: 0 }]);
      expect(await statusGraph(explorationId)).toEqual({ ...before, explorations: [{ ...before.explorations[0],
        status, closed_at: changed.closedAt, updated_at: changed.updatedAt }] });
    });

    it.each([null, 19])("rolls back the real status UPDATE and history initialization at revision %s", async revision => {
      const explorationId = await prepareStatusGraph(previous);
      if (revision === null) await sql`DELETE FROM opening_workspace_history_revisions WHERE workspace_id=${workspaceA}`;
      else await sql`UPDATE opening_workspace_history_revisions SET revision=${revision} WHERE workspace_id=${workspaceA}`;
      const before = await statusGraph(explorationId);
      const fault = new Error("injected after real status update");
      let updated = false;
      const failingSql = new Proxy(sql, {
        get(target, key, receiver) {
          if (key === "begin") return (callback: (tx: TransactionSql) => Promise<unknown>) => target.begin(tx => callback(new Proxy(tx, {
            async apply(query, thisArg, args) {
              const rows = await Reflect.apply(query, thisArg, args);
              if ((args[0] as TemplateStringsArray).join("").includes("UPDATE explorations SET status")) {
                expect(await tx`SELECT status FROM explorations WHERE id=${explorationId}`).toEqual([{ status }]);
                updated = true;
                throw fault;
              }
              return rows;
            },
          })));
          return Reflect.get(target, key, receiver);
        },
      });
      await expect(createExplorationRepository(failingSql).setStatus({ workspaceId: workspaceA, explorationId, status })).rejects.toBe(fault);
      expect(updated).toBe(true);
      expect(await statusGraph(explorationId)).toEqual(before);
      expect(await history()).toEqual(revision === null ? [] : [{ ownerUserId: ownerA, revision }]);
    });
  });

  it.each(["owner-move", "workspace-delete"] as const)("uses the transaction's DB owner for status after a %s", async race => {
    const explorationId = await prepareStatusGraph("open");
    await sql`DELETE FROM opening_workspace_history_revisions WHERE workspace_id=${workspaceA}`;
    const nextOwner = randomUUID();
    await sql`INSERT INTO users (id,email,display_name,password_hash)
      VALUES (${nextOwner},${`${nextOwner}@example.com`},'Next owner','test')`;
    const racedSql = new Proxy(sql, {
      get(target, key, receiver) {
        if (key === "begin") return async (callback: (tx: TransactionSql) => Promise<unknown>) => {
          if (race === "owner-move") await sql`UPDATE workspaces SET owner_user_id=${nextOwner} WHERE id=${workspaceA}`;
          else await sql`DELETE FROM workspaces WHERE id=${workspaceA}`;
          return target.begin(callback);
        };
        return Reflect.get(target, key, receiver);
      },
    });
    const result = createExplorationRepository(racedSql).setStatus({ workspaceId: workspaceA, explorationId, status: "closed" });
    if (race === "workspace-delete") {
      await expect(result).rejects.toMatchObject({ code: "NOT_FOUND", message: `Workspace not found: ${workspaceA}` });
      expect(await history()).toEqual([]);
    } else {
      expect(await result).toMatchObject({ ownerUserId: ownerA, status: "closed" });
      expect(await history()).toEqual([{ ownerUserId: nextOwner, revision: 0 }]);
    }
  });

  it("preserves status validation and error priority before history initialization", async () => {
    const explorationId = await prepareStatusGraph("open");
    await sql`DELETE FROM opening_workspace_history_revisions WHERE workspace_id=${workspaceA}`;
    const before = await statusGraph(explorationId);
    const valid = { workspaceId: workspaceA, explorationId, status: "closed" as const };
    const cases = [
      [{ status: "invalid", workspaceId: "invalid", explorationId: "invalid" }, "VALIDATION", "Invalid exploration status"],
      [{ workspaceId: "invalid", explorationId: "invalid" }, "VALIDATION", "Invalid UUID for workspaceId"],
      [{ workspaceId: randomUUID(), explorationId: "invalid" }, "NOT_FOUND", "Workspace not found:"],
      [{ explorationId: "invalid" }, "VALIDATION", "Invalid UUID for explorationId"],
      [{ explorationId: randomUUID() }, "NOT_FOUND", "Exploration not found:"],
      [{ workspaceId: workspaceB, status: "open" }, "WORKSPACE_MISMATCH", "is not in workspace"],
      [{ status: "open" }, "INVALID_TRANSITION", "Exploration is already open"],
    ] as const;
    for (const [input, code, message] of cases) {
      await expect(repository.setStatus({ ...valid, ...input } as Parameters<ExplorationRepository["setStatus"]>[0]))
        .rejects.toMatchObject({ code, message: expect.stringContaining(message) });
    }
    expect(await sql`SELECT * FROM opening_workspace_history_revisions`).toEqual([]);
    expect(await statusGraph(explorationId)).toEqual(before);
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
