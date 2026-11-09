import { randomUUID } from "node:crypto";
import type { TransactionSql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyMigrations,
  createCourseMembershipRepository,
  createExplorationRepository,
  createPromotionRepository,
  createSqlClient,
  type PromotionRepository,
} from "@aistudy/database";

import { closeRace, openRaceSession, track, waitUntilBlocked } from "./opening-race-helpers";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl)
  throw new Error("DATABASE_URL is required for promotion repository tests");

const ownerId = randomUUID();
const otherOwnerId = randomUUID();
const workspaceId = randomUUID();
const otherWorkspaceId = randomUUID();

describe("promotion repository", () => {
  const sql = createSqlClient(databaseUrl);
  let repository: PromotionRepository;

  beforeAll(async () => {
    await applyMigrations(sql);
    repository = createPromotionRepository(sql);
  });

  beforeEach(async () => {
    await sql`TRUNCATE opening_workspace_history_revisions, promotion_targets, promotion_records, exploration_blocks, exploration_branches, explorations, course_asset_memberships, courses, library_revisions, library_blocks, library_documents, sessions, workspaces, users RESTART IDENTITY CASCADE`;
    await sql`INSERT INTO users (id, email, display_name, password_hash) VALUES (${ownerId}, ${`promotion-${randomUUID()}@example.com`}, 'Owner', 'test'), (${otherOwnerId}, ${`promotion-${randomUUID()}@example.com`}, 'Other owner', 'test')`;
    await sql`INSERT INTO workspaces (id, owner_user_id) VALUES (${workspaceId}, ${ownerId}), (${otherWorkspaceId}, ${otherOwnerId})`;
  });

  afterAll(async () => sql.end({ timeout: 5 }));

  async function exploration() {
    return createExplorationRepository(sql).createExploration({
      workspaceId,
      ownerUserId: ownerId,
      title: "Promotion source",
    });
  }

  async function candidate(kind: "note" | "card", targetWorkspaceId = workspaceId) {
    const source = await createExplorationRepository(sql).createExploration({
      workspaceId: targetWorkspaceId,
      ownerUserId: targetWorkspaceId === workspaceId ? ownerId : otherOwnerId,
      title: "History fence source",
    });
    return repository.create({
      workspaceId: targetWorkspaceId, explorationId: source.id, sourceTurnId: randomUUID(),
      kind, title: "History fence", body: "Preserve provenance",
    });
  }

  async function historyRows() {
    return sql`SELECT workspace_id, owner_user_id, revision::int FROM opening_workspace_history_revisions ORDER BY workspace_id`;
  }

  it.each(["note", "card"] as const)("accept %s lazily ensures history at zero without advancing existing revisions", async (kind) => {
    for (const revision of [null, 0, 31]) {
      const promotion = await candidate(kind);
      await sql`DELETE FROM opening_workspace_history_revisions WHERE workspace_id = ${workspaceId}`;
      if (revision !== null) {
        await sql`INSERT INTO opening_workspace_history_revisions (workspace_id, owner_user_id, revision)
          VALUES (${workspaceId}, ${ownerId}, ${revision})`;
      }
      const input = { workspaceId, promotionId: promotion.id };
      const accepted = await repository.accept(input);
      expect(accepted).toMatchObject({ status: "accepted", explorationId: promotion.explorationId, sourceTurnId: promotion.sourceTurnId });
      expect(await repository.accept(input)).toEqual(accepted);
      expect(await repository.reject(input)).toEqual(accepted);
      expect(await historyRows()).toEqual([{ workspace_id: workspaceId, owner_user_id: ownerId, revision: revision ?? 0 }]);
    }
  });

  async function graph(client: TransactionSql | typeof sql = sql) {
    return {
      records: await client`SELECT * FROM promotion_records ORDER BY id`,
      targets: await client`SELECT * FROM promotion_targets ORDER BY id`,
      documents: await client`SELECT * FROM library_documents ORDER BY id`,
      blocks: await client`SELECT * FROM library_blocks ORDER BY id`,
      revisions: await client`SELECT * FROM library_revisions ORDER BY id`,
    };
  }

  async function expectAcceptedGraph(promotion: Awaited<ReturnType<typeof candidate>>, client: TransactionSql | typeof sql = sql) {
    const input = { workspaceId: promotion.workspaceId, promotionId: promotion.id };
    const [record] = await client`SELECT * FROM promotion_records WHERE id = ${promotion.id}`;
    expect(record).toMatchObject({ status: "accepted", exploration_id: promotion.explorationId, source_turn_id: promotion.sourceTurnId });
    if (promotion.kind === "note") {
      const [document] = await client`SELECT * FROM library_documents WHERE id = ${record!.target_id}`;
      const blocks = await client`SELECT * FROM library_blocks WHERE document_id = ${record!.target_id}`;
      const revisions = await client`SELECT * FROM library_revisions WHERE document_id = ${record!.target_id}`;
      expect(document).toMatchObject({ workspace_id: input.workspaceId, lifecycle: "confirmed", current_revision_number: 1 });
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toMatchObject({ type: "paragraph", content: { text: promotion.body } });
      expect(revisions).toHaveLength(1);
      expect(revisions[0]).toMatchObject({ revision_number: 1, reason: "promotion", blocks: [
        { id: blocks[0]!.id, type: "paragraph", position: 0, content: { text: promotion.body } },
      ] });
      expect(await client`SELECT * FROM promotion_targets WHERE promotion_id = ${promotion.id}`).toHaveLength(0);
    } else {
      const targets = await client`SELECT * FROM promotion_targets WHERE promotion_id = ${promotion.id}`;
      expect(targets).toHaveLength(1);
      expect(targets[0]).toMatchObject({ id: record!.target_id, workspace_id: input.workspaceId,
        kind: promotion.kind, exploration_id: promotion.explorationId, source_turn_id: promotion.sourceTurnId,
        title: promotion.title, body: promotion.body });
    }
  }

  it.each(["note", "card"] as const)("accept %s waits on history before business locks and double accept creates one atomic graph", async (kind) => {
    const promotion = await candidate(kind);
    const input = { workspaceId, promotionId: promotion.id };
    await sql`INSERT INTO opening_workspace_history_revisions (workspace_id, owner_user_id, revision)
      VALUES (${workspaceId}, ${ownerId}, 23)`;
    const original = await graph();
    const holder = openRaceSession();
    const writer = openRaceSession();
    const second = openRaceSession();
    const observer = openRaceSession();
    const pending: Promise<unknown>[] = [];
    try {
      await Promise.all([holder.ready, writer.ready, second.ready, observer.ready]);
      await holder.sql.begin(async (tx) => {
        await tx`SELECT revision FROM opening_workspace_history_revisions WHERE workspace_id = ${workspaceId} FOR UPDATE`;
        const started = performance.now();
        pending.push(track(createPromotionRepository(writer.sql).accept(input)));
        await waitUntilBlocked(observer.sql, writer.pid, holder.pid, "promotion accept history",
          /opening_workspace_history_revisions/);
        pending.push(track(createPromotionRepository(second.sql).accept(input)));
        // A queued waiter may report the first writer as its soft blocker.
        await vi.waitFor(async () => {
          const [activity] = await observer.sql`SELECT query, pg_blocking_pids(pid) AS blockers
            FROM pg_stat_activity WHERE pid = ${second.pid}`;
          expect(activity!.query).toMatch(/opening_workspace_history_revisions/);
          expect((activity!.blockers as number[]).some(pid => pid === holder.pid || pid === writer.pid)).toBe(true);
        }, { interval: 40 });
        await tx`SELECT id FROM promotion_records WHERE id = ${promotion.id} FOR UPDATE NOWAIT`;
        await tx`SELECT id FROM workspaces WHERE id = ${workspaceId} FOR UPDATE NOWAIT`;
        expect(await createPromotionRepository(observer.sql).get(input)).toEqual(promotion);
        expect(await graph(observer.sql)).toEqual(original);
        console.info(`[promotion history:${kind}] actual blocked observation ${Math.round(performance.now() - started)}ms`);
      });
      const [first, repeated] = await Promise.all(pending);
      expect(repeated).toEqual(first);
      await expectAcceptedGraph(promotion);
      expect(await historyRows()).toEqual([{ workspace_id: workspaceId, owner_user_id: ownerId, revision: 23 }]);
    } finally {
      await Promise.allSettled(pending);
      await Promise.all([holder, writer, second, observer].map(session => closeRace(session.sql)));
    }
  });

  it("a different workspace history holder does not block accept", async () => {
    const promotion = await candidate("card", otherWorkspaceId);
    await sql`INSERT INTO opening_workspace_history_revisions (workspace_id, owner_user_id, revision)
      VALUES (${workspaceId}, ${ownerId}, 7)`;
    const holder = openRaceSession();
    const writer = openRaceSession();
    try {
      await Promise.all([holder.ready, writer.ready]);
      await holder.sql.begin(async (tx) => {
        await tx`SELECT revision FROM opening_workspace_history_revisions WHERE workspace_id = ${workspaceId} FOR UPDATE`;
        expect(await createPromotionRepository(writer.sql).accept({ workspaceId: otherWorkspaceId, promotionId: promotion.id }))
          .toMatchObject({ status: "accepted" });
        await expectAcceptedGraph(promotion);
      });
    } finally {
      await Promise.all([closeRace(holder.sql), closeRace(writer.sql)]);
    }
  });

  it.each(["note", "card"] as const)("accept %s rechecks a concurrent rejection after history is released", async (kind) => {
    const promotion = await candidate(kind);
    const input = { workspaceId, promotionId: promotion.id };
    await sql`INSERT INTO opening_workspace_history_revisions (workspace_id, owner_user_id, revision)
      VALUES (${workspaceId}, ${ownerId}, 19)`;
    const holder = openRaceSession();
    const writer = openRaceSession();
    const observer = openRaceSession();
    let pending: Promise<unknown> | undefined;
    let rejected: unknown;
    try {
      await Promise.all([holder.ready, writer.ready, observer.ready]);
      await holder.sql.begin(async (tx) => {
        await tx`SELECT revision FROM opening_workspace_history_revisions WHERE workspace_id = ${workspaceId} FOR UPDATE`;
        pending = track(createPromotionRepository(writer.sql).accept(input));
        await waitUntilBlocked(observer.sql, writer.pid, holder.pid, "accept/reject history race", /opening_workspace_history_revisions/);
        rejected = await createPromotionRepository(observer.sql).reject(input);
      });
      expect(await pending).toEqual(rejected);
      expect(await repository.accept(input)).toEqual(rejected);
      expect(await repository.reject(input)).toEqual(rejected);
      expect(await graph()).toMatchObject({ targets: [], documents: [], blocks: [], revisions: [] });
      expect(await historyRows()).toEqual([{ workspace_id: workspaceId, owner_user_id: ownerId, revision: 19 }]);
    } finally {
      await Promise.allSettled(pending ? [pending] : []);
      await Promise.all([holder, writer, observer].map(session => closeRace(session.sql)));
    }
  });

  it.each(["note", "card"] as const)("accept %s retains UUID, missing and foreign lookup error precedence without ensuring history", async (kind) => {
    const promotion = await candidate(kind);
    const missing = randomUUID();
    const missingWorkspace = randomUUID();
    const cases = [
      { workspaceId: "invalid", promotionId: "invalid", code: "VALIDATION", message: "Invalid UUID for workspaceId" },
      { workspaceId, promotionId: "invalid", code: "VALIDATION", message: "Invalid UUID for promotionId" },
      { workspaceId, promotionId: missing, code: "NOT_FOUND", message: `Promotion not found: ${missing}` },
      { workspaceId: missingWorkspace, promotionId: missing, code: "NOT_FOUND", message: `Promotion not found: ${missing}` },
      ...[otherWorkspaceId, missingWorkspace].map(id => ({ workspaceId: id, promotionId: promotion.id,
        code: "WORKSPACE_MISMATCH", message: `Promotion ${promotion.id} is not in workspace ${id}` })),
    ];
    for (const { code, message, ...input } of cases) {
      await expect(repository.accept(input)).rejects.toMatchObject({ name: "PromotionRepositoryError", code, message });
    }
    expect(await historyRows()).toEqual([]);
    expect(await repository.get({ workspaceId, promotionId: promotion.id })).toEqual(promotion);
    expect(await graph()).toMatchObject({ targets: [], documents: [], blocks: [], revisions: [] });
  });

  it.each(["note", "card"] as const)("accept %s rolls back the real graph and lazy ensure after an injected precommit failure", async (kind) => {
    const promotion = await candidate(kind);
    const input = { workspaceId, promotionId: promotion.id };
    const original = await graph();
    for (const revision of [null, 43]) {
      if (revision !== null) {
        await sql`INSERT INTO opening_workspace_history_revisions (workspace_id, owner_user_id, revision)
          VALUES (${workspaceId}, ${ownerId}, ${revision})`;
      }
      const originalHistory = await historyRows();
      const failure = new Error("injected after actual promotion graph before commit");
      let injected = false;
      const failing = new Proxy(sql, {
        get(target, property, receiver) {
          if (property !== "begin") return Reflect.get(target, property, receiver);
          return (execute: (tx: TransactionSql) => Promise<unknown>) => target.begin(async tx => {
            await execute(tx);
            await expectAcceptedGraph(promotion, tx);
            const [history] = await tx`SELECT revision::int FROM opening_workspace_history_revisions WHERE workspace_id = ${workspaceId}`;
            expect(history!.revision).toBe(revision ?? 0);
            expect(await graph()).toEqual(original);
            injected = true;
            throw failure;
          });
        },
      });
      await expect(createPromotionRepository(failing).accept(input)).rejects.toBe(failure);
      expect(injected).toBe(true);
      expect(await graph()).toEqual(original);
      expect(await historyRows()).toEqual(originalHistory);
    }
  });

  it("reports the promotion missing when workspace deletion commits between the preliminary reads", async () => {
    const promotion = await candidate("note");
    let deleted = false;
    const racing = new Proxy(sql, {
      get(target, property, receiver) {
        if (property !== "begin") return Reflect.get(target, property, receiver);
        return (execute: (tx: TransactionSql) => Promise<unknown>) => target.begin(tx => execute(new Proxy(tx, {
          async apply(query, thisArg, args) {
            const result = await Reflect.apply(query, thisArg, args);
            if (!deleted && (args[0] as TemplateStringsArray).join("").startsWith("SELECT * FROM promotion_records")) {
              await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`;
              deleted = true;
            }
            return result;
          },
        })));
      },
    });
    await expect(createPromotionRepository(racing).accept({ workspaceId, promotionId: promotion.id }))
      .rejects.toMatchObject({ name: "PromotionRepositoryError", code: "NOT_FOUND", message: `Promotion not found: ${promotion.id}` });
    expect(deleted).toBe(true);
    expect(await historyRows()).toEqual([]);
    expect(await graph()).toMatchObject({ records: [], targets: [], documents: [], blocks: [], revisions: [] });
  });

  it.each(["accepted", "rejected"] as const)("accept replays legacy %s decisions while still ensuring history", async status => {
    const promotion = await candidate("card");
    const input = { workspaceId, promotionId: promotion.id };
    const terminal = status === "accepted" ? await repository.accept(input) : await repository.reject(input);
    await sql`DELETE FROM opening_workspace_history_revisions WHERE workspace_id = ${workspaceId}`;
    const original = await graph();
    expect(await repository.accept(input)).toEqual(terminal);
    expect(await graph()).toEqual(original);
    expect(await historyRows()).toEqual([{ workspace_id: workspaceId, owner_user_id: ownerId, revision: 0 }]);
  });

  it("reviews candidates independently and keeps terminal decisions idempotent", async () => {
    const source = await exploration();
    const acceptedCandidate = await repository.create({
      workspaceId,
      explorationId: source.id,
      kind: "note",
      title: "Keep",
      body: "Confirmed insight",
    });
    const rejectedCandidate = await repository.create({
      workspaceId,
      explorationId: source.id,
      kind: "question",
      title: "Discard",
      body: "Unresolved?",
    });

    const accepted = await repository.accept({
      workspaceId,
      promotionId: acceptedCandidate.id,
    });
    const rejected = await repository.reject({
      workspaceId,
      promotionId: rejectedCandidate.id,
    });
    const repeated = await repository.reject({
      workspaceId,
      promotionId: rejectedCandidate.id,
    });

    expect(accepted).toMatchObject({
      status: "accepted",
      targetType: "document",
    });
    expect(rejected).toMatchObject({
      status: "rejected",
      targetType: null,
      targetId: null,
    });
    expect(repeated).toEqual(rejected);
    expect(
      await repository.get({ workspaceId, promotionId: accepted.id }),
    ).toMatchObject({ status: "accepted", targetId: accepted.targetId });
  });

  it("materializes one confirmed note with provenance and a stable target", async () => {
    const source = await exploration();
    const sourceTurnId = randomUUID();
    const candidate = await repository.create({
      workspaceId,
      explorationId: source.id,
      sourceTurnId,
      kind: "note",
      title: "Atomic note",
      body: "One paragraph",
    });
    const first = await repository.accept({
      workspaceId,
      promotionId: candidate.id,
    });
    const second = await repository.accept({
      workspaceId,
      promotionId: candidate.id,
    });
    const documents =
      await sql`SELECT * FROM library_documents WHERE id = ${first.targetId}`;
    const blocks =
      await sql`SELECT type, content FROM library_blocks WHERE document_id = ${first.targetId}`;
    const revisions =
      await sql`SELECT revision_number, reason FROM library_revisions WHERE document_id = ${first.targetId}`;

    expect(second.targetId).toBe(first.targetId);
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({
      lifecycle: "confirmed",
      current_revision_number: 1,
    });
    expect(blocks[0]).toMatchObject({
      type: "paragraph",
      content: { text: "One paragraph" },
    });
    expect(revisions[0]).toMatchObject({
      revision_number: 1,
      reason: "promotion",
    });
    expect(first.sourceTurnId).toBe(sourceTurnId);
  });

  it("creates a typed non-document target and rejects workspace leaks", async () => {
    const source = await exploration();
    const card = await repository.create({
      workspaceId,
      explorationId: source.id,
      kind: "card",
      title: "Front",
      body: "Back",
    });
    const accepted = await repository.accept({
      workspaceId,
      promotionId: card.id,
    });
    const targets =
      await sql`SELECT kind, title, body, exploration_id FROM promotion_targets WHERE id = ${accepted.targetId}`;

    expect(accepted.targetType).toBe("card");
    expect(targets[0]).toMatchObject({
      kind: "card",
      title: "Front",
      body: "Back",
      exploration_id: source.id,
    });
    await expect(
      repository.get({ workspaceId: otherWorkspaceId, promotionId: card.id }),
    ).rejects.toMatchObject({ code: "WORKSPACE_MISMATCH" });
    await expect(
      repository.create({
        workspaceId: otherWorkspaceId,
        explorationId: source.id,
        kind: "note",
        title: "Denied",
        body: "Denied",
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_MISMATCH" });
  });

  it("reuses the promoted document across two course memberships", async () => {
    const source = await exploration();
    const promoted = await repository.accept({
      workspaceId,
      promotionId: (
        await repository.create({
          workspaceId,
          explorationId: source.id,
          kind: "note",
          title: "Shared",
          body: "Reusable",
        })
      ).id,
    });
    const memberships = createCourseMembershipRepository(sql);
    const courseA = randomUUID();
    const courseB = randomUUID();
    await sql`INSERT INTO courses (id, workspace_id, title, slug) VALUES (${courseA}, ${workspaceId}, 'A', 'course-a'), (${courseB}, ${workspaceId}, 'B', 'course-b')`;
    await memberships.addAssetMembership({
      workspaceId,
      courseId: courseA,
      assetType: "document",
      assetId: promoted.targetId!,
      role: "core",
      visibility: "course",
    });
    await memberships.addAssetMembership({
      workspaceId,
      courseId: courseB,
      assetType: "document",
      assetId: promoted.targetId!,
      role: "core",
      visibility: "course",
    });
    const rows =
      await sql`SELECT asset_id FROM course_asset_memberships WHERE asset_id = ${promoted.targetId}`;
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.asset_id))).toEqual(
      new Set([promoted.targetId]),
    );
  });
});
