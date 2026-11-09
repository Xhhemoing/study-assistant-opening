import { randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { lockWorkspaceLearningHistory } from "../../packages/database/src/repositories/opening-learning-facts";
import { openRaceSession } from "./opening-race-helpers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  CardRepositoryError,
  createCardRepository,
  createCourseMembershipRepository,
  createIdentityRepository,
  createLearningEventRepository,
  createSqlClient,
  type CardRepository,
  type CourseMembershipRepository,
  type IdentityRepository,
  type LearningEventRepository,
} from "@aistudy/database";
import { defaultGoalAbilities, type GoalKind } from "@aistudy/domain";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for card multi-goal state tests");
}

describe("card multi-goal personal SRS state", () => {
  const sql = createSqlClient(databaseUrl);
  let identity: IdentityRepository;
  let courses: CourseMembershipRepository;
  let cards: CardRepository;
  let events: LearningEventRepository;
  let workspaceId: string;
  let ownerUserId: string;
  let otherWorkspaceId: string;
  let courseA: string;
  let courseB: string;
  let cardId: string;

  beforeAll(async () => {
    await applyMigrations(sql);
    identity = createIdentityRepository(sql);
    courses = createCourseMembershipRepository(sql);
    cards = createCardRepository(sql);
    events = createLearningEventRepository(sql);
  });

  beforeEach(async () => {
    await sql`TRUNCATE
      learning_events,
      card_review_states,
      cards,
      goal_time_windows,
      course_goals,
      course_asset_memberships,
      courses,
      sessions,
      workspaces,
      users
      RESTART IDENTITY CASCADE`;

    const owner = await identity.createUserWithWorkspace({
      email: `card-a-${randomUUID()}@example.com`,
      displayName: "Card owner",
      passwordHash: "scrypt$not-used",
    });
    const other = await identity.createUserWithWorkspace({
      email: `card-b-${randomUUID()}@example.com`,
      displayName: "Other",
      passwordHash: "scrypt$not-used",
    });
    workspaceId = owner.workspace.id;
    ownerUserId = owner.user.id;
    otherWorkspaceId = other.workspace.id;
    courseA = (await courses.createCourse({ workspaceId, title: "A", slug: "course-a" })).id;
    courseB = (await courses.createCourse({ workspaceId, title: "B", slug: "course-b" })).id;

    const card = await cards.createCard({
      workspaceId,
      ownerUserId,
      front: "导数",
      back: "极限定义",
      tags: ["高数"],
    });
    cardId = card.id;

    await courses.addAssetMembership({
      workspaceId,
      courseId: courseA,
      assetType: "card",
      assetId: cardId,
      role: "core",
      visibility: "course",
    });
    await courses.addAssetMembership({
      workspaceId,
      courseId: courseB,
      assetType: "card",
      assetId: cardId,
      role: "optional",
      visibility: "course",
    });

    await insertGoal(courseA, "final-exam", 2, 120);
    await insertGoal(courseA, "interest", 1, null);
    await insertGoal(courseB, "maintenance", 4, 60);
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  async function insertGoal(
    courseId: string,
    kind: GoalKind,
    priority: number,
    examDaysFromToday: number | null,
  ): Promise<string> {
    // The DB enforces a non-past exam date independently of the fixed review clock.
    const rows = await sql<{ id: string }[]>`
      INSERT INTO course_goals (
        workspace_id, course_id, kind, title, priority, intensity,
        abilities, strategy_version, active, exam_date
      )
      VALUES (
        ${workspaceId}, ${courseId}, ${kind}, ${kind}, ${priority}, 0.5,
        ${sql.json(defaultGoalAbilities(kind))}, 'goal-1', true, CURRENT_DATE + ${examDaysFromToday}::int
      )
      RETURNING id
    `;
    return rows[0]!.id;
  }

  it("keeps one card and one personal state across two courses and three goals", async () => {
    const cardRows = await sql`SELECT count(*)::int AS count FROM cards`;
    expect(cardRows[0]?.count).toBe(1);

    const initial = await cards.upsertState({
      workspaceId,
      ownerUserId,
      state: {
        cardId,
        ease: 2.5,
        intervalDays: 0,
        dueAt: "2026-08-15T00:00:00.000Z",
        reps: 0,
        lapses: 0,
        lastGrade: null,
        updatedAt: "2026-08-15T00:00:00.000Z",
      },
    });
    const again = await cards.upsertState({
      workspaceId,
      ownerUserId,
      state: { ...initial, dueAt: "2026-08-15T01:00:00.000Z", updatedAt: "2026-08-15T01:00:00.000Z" },
    });
    const stateRows = await sql`
      SELECT count(*)::int AS count FROM card_review_states
      WHERE owner_user_id = ${ownerUserId} AND card_id = ${cardId}
    `;
    expect(stateRows[0]?.count).toBe(1);
    expect(again.reps).toBe(0);

    const first = await cards.grade({
      workspaceId,
      ownerUserId,
      cardId,
      grade: "good",
      idempotencyKey: "review-key-01",
      occurredAt: "2026-08-15T02:00:00.000Z",
      now: new Date("2026-08-15T02:00:00.000Z"),
    });
    const second = await cards.grade({
      workspaceId,
      ownerUserId,
      cardId,
      grade: "hard",
      idempotencyKey: "review-key-02",
      occurredAt: "2026-08-15T03:00:00.000Z",
      now: new Date("2026-08-15T03:00:00.000Z"),
    });
    expect(first.state.reps).toBe(1);
    expect(second.state.reps).toBe(2);
    expect(second.state.lastGrade).toBe("hard");

    const retried = await cards.grade({
      workspaceId,
      ownerUserId,
      cardId,
      grade: "easy",
      idempotencyKey: "review-key-02",
      occurredAt: "2026-08-15T04:00:00.000Z",
      now: new Date("2026-08-15T04:00:00.000Z"),
    });
    expect(retried.state).toEqual(second.state);
    expect(retried.event).toEqual(second.event);
    const eventCount = await sql`SELECT count(*)::int AS count FROM learning_events WHERE type = 'review'`;
    expect(eventCount[0]?.count).toBe(2);

    const beforeGoals = await cards.getState({ workspaceId, ownerUserId, cardId });
    await sql`UPDATE course_goals SET priority = 99, exam_date = CURRENT_DATE + 180 WHERE course_id = ${courseB}`;
    const afterGoals = await cards.getState({ workspaceId, ownerUserId, cardId });
    expect(afterGoals).toEqual(beforeGoals);
  });

  it("scopes reads and grades to the workspace", async () => {
    await cards.upsertState({
      workspaceId,
      ownerUserId,
      state: {
        cardId,
        ease: 2.5,
        intervalDays: 0,
        dueAt: "2026-08-15T00:00:00.000Z",
        reps: 0,
        lapses: 0,
        lastGrade: null,
        updatedAt: "2026-08-15T00:00:00.000Z",
      },
    });
    await expect(cards.getCard({ workspaceId: otherWorkspaceId, cardId })).rejects.toThrow();
    await expect(
      cards.grade({
        workspaceId: otherWorkspaceId,
        ownerUserId,
        cardId,
        grade: "good",
        idempotencyKey: "foreign-key-01",
        occurredAt: "2026-08-15T02:00:00.000Z",
      }),
    ).rejects.toThrow();
  });

  it("honors auto/self-selected/free with pause archive exclude and maintain-until", async () => {
    const now = new Date("2026-08-15T12:00:00.000Z");
    await cards.upsertState({
      workspaceId,
      ownerUserId,
      state: {
        cardId,
        ease: 2.5,
        intervalDays: 1,
        dueAt: "2026-08-14T12:00:00.000Z",
        reps: 0,
        lapses: 0,
        lastGrade: null,
        updatedAt: "2026-08-14T12:00:00.000Z",
      },
    });

    let queue = await cards.listQueue({
      workspaceId,
      ownerUserId,
      mode: "auto",
      now,
      today: "2026-08-15",
    });
    expect(queue).toHaveLength(1);
    expect(queue[0]?.goalPriority).toBe(4);

    await cards.updateControls({
      workspaceId,
      cardId,
      pausedUntil: "2026-08-20T00:00:00.000Z",
    });
    for (const mode of ["auto", "self-selected", "free"] as const) {
      expect(await cards.listQueue({ workspaceId, ownerUserId, mode, now, today: "2026-08-15" })).toHaveLength(0);
    }

    await cards.updateControls({ workspaceId, cardId, pausedUntil: null, archived: true });
    expect(await cards.listQueue({ workspaceId, ownerUserId, mode: "free", now, today: "2026-08-15" })).toHaveLength(0);

    await cards.updateControls({
      workspaceId,
      cardId,
      archived: false,
      maintainUntil: "2026-08-14",
      excludeFromAssessment: true,
    });
    expect(await cards.listQueue({ workspaceId, ownerUserId, mode: "auto", now, today: "2026-08-15" })).toHaveLength(0);
    queue = await cards.listQueue({
      workspaceId,
      ownerUserId,
      mode: "self-selected",
      now,
      today: "2026-08-15",
    });
    expect(queue).toHaveLength(1);
    expect(queue[0]?.card.excludeFromAssessment).toBe(true);

    const graded = await cards.grade({
      workspaceId,
      ownerUserId,
      cardId,
      grade: "good",
      idempotencyKey: "review-exclude-01",
      occurredAt: "2026-08-15T13:00:00.000Z",
      now: new Date("2026-08-15T13:00:00.000Z"),
    });
    expect(graded.event.payload).toEqual({
      grade: "good",
      assisted: false,
      excludeFromAssessment: true,
    });
    expect(graded.event.contentVersion).toBe(1);
    const stored = await events.get({ workspaceId, eventId: graded.event.id });
    expect(stored.payload).toEqual({
      grade: "good",
      assisted: false,
      excludeFromAssessment: true,
    });
  });

  describe("controls history-first fence", () => {
    const history = () => sql`SELECT * FROM opening_workspace_history_revisions WHERE workspace_id=${workspaceId} ORDER BY owner_user_id`;
    const coverage = () => sql`SELECT * FROM opening_course_question_exposure_coverage WHERE workspace_id=${workspaceId}`;
    const facts = () => sql`SELECT * FROM opening_course_question_exposures WHERE workspace_id=${workspaceId} ORDER BY id`;
    const cardRows = () => sql`SELECT * FROM cards WHERE id=${cardId}`;
    const graphs = () => sql`SELECT * FROM opening_course_knowledge WHERE workspace_id=${workspaceId} ORDER BY course_id`;
    function barrier() {
      let release!: () => void;
      const ready = new Promise<void>(resolve => { release = resolve; });
      return { ready, release };
    }
    // Interception schedules real concurrent SQL; it never substitutes query results.
    function observed(hook: (query: string, phase: "before" | "after", client: Sql | TransactionSql) => Promise<void>): Sql {
      function wrap<T extends Sql | TransactionSql>(client: T): T {
        return new Proxy(client, {
          apply(target, thisArg, args: [TemplateStringsArray, ...unknown[]]) {
            if (!Array.isArray(args[0]) || !("raw" in args[0])) return Reflect.apply(target, thisArg, args);
            const query = args[0].join("?").replace(/\s+/g, " ").trim();
            // Leave composable postgres.js fragments lazy and intact.
            if (!/^(SELECT|UPDATE|INSERT|DELETE)\b/.test(query)) return Reflect.apply(target, thisArg, args);
            return (async () => {
              await hook(query, "before", target);
              const rows = await Reflect.apply(target, thisArg, args);
              await hook(query, "after", target);
              return rows;
            })();
          },
          get(target, property) {
            if (property !== "begin") return Reflect.get(target, property);
            return (callback: (tx: TransactionSql) => Promise<unknown>) => sql.begin(tx => callback(wrap(tx)));
          },
        });
      }
      return wrap(sql);
    }
    async function seedHistoryGraph() {
      await sql`DELETE FROM opening_workspace_history_revisions WHERE workspace_id=${workspaceId}`;
      await sql`INSERT INTO opening_course_knowledge(workspace_id,owner_user_id,course_id,version,snapshot,source_versions)
        VALUES(${workspaceId},${ownerUserId},${courseA},1,${sql.json({ courseId: courseA, version: 1,
          nodes: [{ id: randomUUID(), courseId: courseA, label: "nonempty graph", kind: "concept", evidenceChunkIds: [], status: "supported" }], edges: [] })},'{}')`;
      await sql`INSERT INTO opening_course_question_exposures(id,workspace_id,owner_user_id,surface_key,kind,source_versions,history_revision)
        VALUES(${randomUUID()},${workspaceId},${ownerUserId},'controls-test','presented','{}',0)`;
      await sql`UPDATE opening_course_question_exposure_coverage SET complete=true WHERE workspace_id=${workspaceId}`;
    }
    async function readableSource() {
      const sourceId = randomUUID();
      await sql`INSERT INTO opening_sources(id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state)
        VALUES(${sourceId},${workspaceId},'controls.png','image/png',8,${"a".repeat(64)},1,'uploaded','ready')`;
      await sql`UPDATE cards SET source_ids=${[sourceId]} WHERE id=${cardId}`;
      return sourceId;
    }
    async function blocked(writer: number, holder: number, finished: () => boolean) {
      const deadline = Date.now() + 1800;
      do {
        const [wait] = await sql`SELECT a.query FROM pg_stat_activity a WHERE a.pid=${writer}
          AND ${holder}=ANY(pg_blocking_pids(a.pid))
          AND EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=a.pid AND NOT l.granted)`;
        if (wait) return String(wait.query);
      } while (!finished() && Date.now() < deadline);
      throw new Error("controls did not block on history before business locks");
    }

    it.each(["lazy", "nonzero", "other-workspace"])("history barrier %s", async mode => {
      await seedHistoryGraph();
      if (mode === "nonzero") {
        await sql.begin(tx => lockWorkspaceLearningHistory(tx, { workspaceId, ownerUserId }));
        await sql`UPDATE opening_workspace_history_revisions SET revision=19 WHERE workspace_id=${workspaceId}`;
      }
      const [other] = await sql`SELECT owner_user_id FROM workspaces WHERE id=${otherWorkspaceId}`;
      const holder = openRaceSession(), writer = openRaceSession();
      const held = barrier(), release = barrier();
      let heldTx!: TransactionSql;
      let holding: Promise<unknown> | undefined, writing: Promise<unknown> | undefined;
      const before = { card: await cardRows(), coverage: await coverage(), graph: await graphs(), facts: await facts() };
      expect(before.graph[0]?.snapshot.nodes).toHaveLength(1);
      expect(before.facts).toHaveLength(1);
      try {
        await Promise.all([holder.ready, writer.ready]);
        holding = holder.sql.begin(async tx => {
          await lockWorkspaceLearningHistory(tx, mode === "other-workspace"
            ? { workspaceId: otherWorkspaceId, ownerUserId: String(other!.owner_user_id) } : { workspaceId, ownerUserId });
          heldTx = tx; held.release(); await release.ready;
        });
        holding.catch(held.release); await Promise.race([held.ready, holding]);
        let finished = false;
        writing = createCardRepository(writer.sql).updateControls({ workspaceId, cardId, archived: true });
        writing.then(() => { finished = true; }, () => { finished = true; });
        if (mode !== "other-workspace") {
          const query = await blocked(writer.pid, holder.pid, () => finished);
          expect(query).toContain("opening_workspace_history_revisions");
          const locks = await sql`SELECT c.relname,l.mode FROM pg_locks l JOIN pg_class c ON c.oid=l.relation
            WHERE l.pid=${writer.pid} AND l.granted AND c.relkind='r' AND l.mode IN ('RowShareLock','RowExclusiveLock')`;
          expect(locks.length).toBeGreaterThan(0);
          expect(locks.every(row => row.relname === "opening_workspace_history_revisions")).toBe(true);
          await heldTx`SELECT id FROM cards WHERE id=${cardId} FOR UPDATE NOWAIT`;
          await heldTx`SELECT workspace_id FROM opening_course_question_exposure_coverage WHERE workspace_id=${workspaceId} FOR UPDATE NOWAIT`;
          await heldTx`SELECT id FROM workspaces WHERE id=${workspaceId} FOR UPDATE NOWAIT`;
          expect({ card: await cardRows(), coverage: await coverage(), graph: await graphs(), facts: await facts() }).toEqual(before);
          console.info("controls history barrier", { mode, query, locks, blockingPids: true, ungranted: true });
          release.release(); await holding;
        }
        await expect(writing).resolves.toMatchObject({ id: cardId, archived: true });
        expect(await graphs()).toEqual(before.graph);
        expect(await facts()).toEqual(before.facts);
        expect(await coverage()).toEqual(before.coverage.map(row => ({ ...row, invalidated: true, complete: false })));
        expect(await history()).toMatchObject([{ owner_user_id: ownerUserId, revision: mode === "nonzero" ? "19" : "0" }]);
      } finally {
        release.release(); await Promise.allSettled([holding, writing].filter(Boolean));
        await Promise.all([holder.sql.end({ timeout: 5 }), writer.sql.end({ timeout: 5 })]);
      }
    });

    it.each(["foreign", "missing", "unreadable", "invalid-card", "invalid-workspace"])("lookup before invalid controls/history: %s", async kind => {
      await seedHistoryGraph();
      let id = cardId, workspace = workspaceId;
      if (kind === "foreign") workspace = otherWorkspaceId;
      if (kind === "missing") id = randomUUID();
      if (kind === "invalid-card") id = "bad-uuid";
      if (kind === "invalid-workspace") workspace = "bad-workspace";
      if (kind === "unreadable") {
        const sourceId = await readableSource();
        await sql`UPDATE opening_sources SET upload_state='pending' WHERE id=${sourceId}`;
      }
      const before = { card: await cardRows(), coverage: await coverage(), graph: await graphs(), facts: await facts() };
      const work = cards.updateControls({ workspaceId: workspace, cardId: id, maintainUntil: "not-a-date" });
      if (kind.startsWith("invalid-")) await expect(work).rejects.toMatchObject({ code: "22P02" });
      else {
        await expect(work).rejects.toBeInstanceOf(CardRepositoryError);
        await expect(work).rejects.toMatchObject({ code: "NOT_FOUND", message: `Card not found: ${id}` });
      }
      expect(await history()).toEqual([]);
      expect({ card: await cardRows(), coverage: await coverage(), graph: await graphs(), facts: await facts() }).toEqual(before);
    });

    it.each([0, 19])("keeps revision %s, raw body/SRS and null/undefined/false semantics", async revision => {
      await seedHistoryGraph();
      await sql`UPDATE cards SET front='  raw front  ',back='  raw back  ',paused_until='2026-08-20',maintain_until='2026-09-01',
        archived=true,exclude_from_assessment=true,updated_at='2026-01-01' WHERE id=${cardId}`;
      if (revision) {
        await sql.begin(tx => lockWorkspaceLearningHistory(tx, { workspaceId, ownerUserId }));
        await sql`UPDATE opening_workspace_history_revisions SET revision=${revision} WHERE workspace_id=${workspaceId}`;
      }
      const [before] = await cardRows();
      const state = await cards.getState({ workspaceId, ownerUserId, cardId });
      const graph = await graphs(), exposures = await facts();
      const kept = await cards.updateControls({ workspaceId, cardId, archived: false, excludeFromAssessment: false });
      expect(kept).toMatchObject({ front: "  raw front  ", back: "  raw back  ", archived: false,
        excludeFromAssessment: false, pausedUntil: "2026-08-20T00:00:00.000Z", maintainUntil: "2026-09-01" });
      const cleared = await cards.updateControls({ workspaceId, cardId, pausedUntil: null, maintainUntil: null });
      expect(cleared).toMatchObject({ archived: false, excludeFromAssessment: false, pausedUntil: null, maintainUntil: null });
      const [after] = await cardRows();
      expect(after).toEqual({ ...before, archived: false, exclude_from_assessment: false, paused_until: null, maintain_until: null, updated_at: expect.any(Date) });
      expect(after!.updated_at).not.toEqual(before!.updated_at);
      await cards.updateControls({ workspaceId, cardId });
      expect(await history()).toMatchObject([{ revision: String(revision) }]);
      expect(await cards.getState({ workspaceId, ownerUserId, cardId })).toEqual(state);
      expect(await graphs()).toEqual(graph); expect(await facts()).toEqual(exposures);
      expect(await coverage()).toMatchObject([{ complete: false, invalidated: true }]);
    });

    it.each([0, 19])("empty controls still update timestamp/invalidate coverage without advancing revision %s", async revision => {
      await seedHistoryGraph();
      if (revision) {
        await sql.begin(tx => lockWorkspaceLearningHistory(tx, { workspaceId, ownerUserId }));
        await sql`UPDATE opening_workspace_history_revisions SET revision=${revision} WHERE workspace_id=${workspaceId}`;
      }
      const [before] = await cardRows(), graph = await graphs(), exposures = await facts();
      expect(await coverage()).toMatchObject([{ complete: true, invalidated: false }]);
      const returned = await cards.updateControls({ workspaceId, cardId });
      expect(returned).toEqual(await cards.getCard({ workspaceId, cardId }));
      const [after] = await cardRows();
      expect(after).toEqual({ ...before, updated_at: expect.any(Date) });
      expect(after!.updated_at).not.toEqual(before!.updated_at);
      expect(await history()).toMatchObject([{ revision: String(revision) }]);
      expect(await coverage()).toMatchObject([{ complete: false, invalidated: true }]);
      expect(await graphs()).toEqual(graph); expect(await facts()).toEqual(exposures);
    });

    it.each(["before-helper", "after-history"])("rejects canonical owner drift %s without new-key retry", async window => {
      await seedHistoryGraph();
      const [other] = await sql`SELECT owner_user_id FROM workspaces WHERE id=${otherWorkspaceId}`;
      await sql`DELETE FROM workspaces WHERE id=${otherWorkspaceId}`;
      await sql`INSERT INTO opening_workspace_history_revisions(workspace_id,owner_user_id,revision) VALUES(${workspaceId},${other!.owner_user_id},27)`;
      const before = { card: await cardRows(), coverage: await coverage(), graph: await graphs(), facts: await facts(), history: await history() };
      let changed = false;
      const client = observed(async (query, phase) => {
        const boundary = window === "before-helper" ? query.startsWith("SELECT owner_user_id") && !query.includes("FOR SHARE")
          : query.startsWith("SELECT revision FROM opening_workspace_history_revisions");
        if (!changed && boundary && phase === "after") {
          changed = true;
          await sql`UPDATE workspaces SET owner_user_id=${other!.owner_user_id} WHERE id=${workspaceId}`;
        }
      });
      const work = createCardRepository(client).updateControls({ workspaceId, cardId, maintainUntil: "not-a-date" });
      await expect(work).rejects.toBeInstanceOf(CardRepositoryError);
      await expect(work).rejects.toMatchObject({ code: "NOT_FOUND", message: `Card not found: ${cardId}` });
      expect(changed).toBe(true);
      expect({ card: await cardRows(), coverage: await coverage(), graph: await graphs(), facts: await facts(), history: await history() }).toEqual(before);
    });

    it.each(["before-helper", "after-history"])("rejects workspace deletion %s and rolls lazy ensure back", async window => {
      await seedHistoryGraph(); let changed = false;
      const client = observed(async (query, phase) => {
        const boundary = window === "before-helper" ? query.startsWith("SELECT owner_user_id") && !query.includes("FOR SHARE")
          : query.startsWith("SELECT revision FROM opening_workspace_history_revisions");
        if (!changed && boundary && phase === "after") { changed = true; await sql`DELETE FROM workspaces WHERE id=${workspaceId}`; }
      });
      const work = createCardRepository(client).updateControls({ workspaceId, cardId });
      await expect(work).rejects.toBeInstanceOf(CardRepositoryError);
      await expect(work).rejects.toMatchObject({ code: "NOT_FOUND", message: `Card not found: ${cardId}` });
      expect(changed).toBe(true); expect(await history()).toEqual([]); expect(await cardRows()).toEqual([]);
    });

    it.each(["delete", "move", "owner", "unreadable"])("rejects card %s after history with rollback", async change => {
      await seedHistoryGraph();
      const [other] = await sql`SELECT owner_user_id FROM workspaces WHERE id=${otherWorkspaceId}`;
      if (change === "owner") await sql`DELETE FROM workspaces WHERE id=${otherWorkspaceId}`;
      const sourceId = change === "unreadable" ? await readableSource() : null;
      let changed = false, external: unknown;
      const client = observed(async (query, phase) => {
        if (!changed && query.startsWith("SELECT revision FROM opening_workspace_history_revisions") && phase === "after") {
          changed = true;
          if (change === "delete") await sql`DELETE FROM cards WHERE id=${cardId}`;
          if (change === "move") await sql`UPDATE cards SET workspace_id=${otherWorkspaceId},owner_user_id=${other!.owner_user_id},course_id=NULL WHERE id=${cardId}`;
          if (change === "owner") {
            // A real scope-consistent card mutation, then restore the canonical
            // workspace owner before the writer resumes its locked reread.
            await sql`UPDATE workspaces SET owner_user_id=${other!.owner_user_id} WHERE id=${workspaceId}`;
            await sql`UPDATE cards SET owner_user_id=${other!.owner_user_id} WHERE id=${cardId}`;
            await sql`UPDATE workspaces SET owner_user_id=${ownerUserId} WHERE id=${workspaceId}`;
          }
          if (change === "unreadable") await sql`UPDATE opening_sources SET upload_state='pending' WHERE id=${sourceId}`;
          external = { card: await cardRows(), coverage: await coverage(), graph: await graphs(), facts: await facts() };
        }
      });
      const work = createCardRepository(client).updateControls({ workspaceId, cardId, archived: true });
      await expect(work).rejects.toBeInstanceOf(CardRepositoryError);
      await expect(work).rejects.toMatchObject({ code: "NOT_FOUND", message: `Card not found: ${cardId}` });
      expect(changed).toBe(true); expect(await history()).toEqual([]);
      expect({ card: await cardRows(), coverage: await coverage(), graph: await graphs(), facts: await facts() }).toEqual(external);
    });

    it.each(["delete", "move"])("maps zero-row UPDATE after reread (%s) to typed NOT_FOUND", async change => {
      await seedHistoryGraph(); let changed = false;
      const [other] = await sql`SELECT owner_user_id FROM workspaces WHERE id=${otherWorkspaceId}`;
      const client = observed(async (query, phase) => {
        if (!changed && query.startsWith("UPDATE cards SET") && phase === "before") {
          changed = true;
          if (change === "delete") await sql`DELETE FROM cards WHERE id=${cardId}`;
          else await sql`UPDATE cards SET workspace_id=${otherWorkspaceId},owner_user_id=${other!.owner_user_id},course_id=NULL WHERE id=${cardId}`;
        }
      });
      const work = createCardRepository(client).updateControls({ workspaceId, cardId });
      await expect(work).rejects.toBeInstanceOf(CardRepositoryError);
      await expect(work).rejects.toMatchObject({ code: "NOT_FOUND", message: `Card not found: ${cardId}` });
      expect(changed).toBe(true); expect(await history()).toEqual([]);
    });

    it("rejects returned same-scope owner drift after reread, without suppressing the static SQL guard", async () => {
      await seedHistoryGraph();
      const [other] = await sql`SELECT owner_user_id FROM workspaces WHERE id=${otherWorkspaceId}`;
      await sql`DELETE FROM workspaces WHERE id=${otherWorkspaceId}`;
      await sql`UPDATE workspaces SET owner_user_id=${other!.owner_user_id} WHERE id=${workspaceId}`;
      let changed = false, external: unknown;
      const client = observed(async (query, phase) => {
        if (!changed && query.startsWith("UPDATE cards SET") && phase === "before") {
          changed = true;
          // Bring the card into canonical scope after its reread; the real
          // storage guard allows this, so RETURNING must detect the drift.
          await sql`UPDATE cards SET owner_user_id=${other!.owner_user_id} WHERE id=${cardId}`;
          external = { card: await cardRows(), coverage: await coverage(), graph: await graphs(), facts: await facts() };
        }
      });
      const work = createCardRepository(client).updateControls({ workspaceId, cardId, archived: true });
      await expect(work).rejects.toBeInstanceOf(CardRepositoryError);
      await expect(work).rejects.toMatchObject({ code: "NOT_FOUND", message: `Card not found: ${cardId}` });
      expect(changed).toBe(true); expect(await history()).toEqual([]);
      expect({ card: await cardRows(), coverage: await coverage(), graph: await graphs(), facts: await facts() }).toEqual(external);
    });

    it("retains static card/workspace owner mismatch SQL guard", async () => {
      await seedHistoryGraph();
      const [other] = await sql`SELECT owner_user_id FROM workspaces WHERE id=${otherWorkspaceId}`;
      await sql`DELETE FROM workspaces WHERE id=${otherWorkspaceId}`;
      await sql`UPDATE workspaces SET owner_user_id=${other!.owner_user_id} WHERE id=${workspaceId}`;
      const before = await cardRows();
      await expect(cards.updateControls({ workspaceId, cardId, archived: true })).rejects.toMatchObject({ code: "23000" });
      expect(await cardRows()).toEqual(before); expect(await history()).toEqual([]);
    });

    it.each(["maintainUntil", "pausedUntil"] as const)("retains postgres.js normalization of input 2026-02-30 for %s", async field => {
      await seedHistoryGraph();
      // postgres.js date serialization normalizes this input before PG sees it.
      const updated = await cards.updateControls({ workspaceId, cardId, [field]: "2026-02-30" });
      expect(updated[field]).toBe(field === "maintainUntil" ? "2026-03-02" : "2026-03-02T00:00:00.000Z");
    });

    it("rolls back real UPDATE/trigger and lazy history on a later real PG invalid-date error", async () => {
      await seedHistoryGraph();
      const before = { card: await cardRows(), coverage: await coverage(), graph: await graphs(), facts: await facts() };
      let updated = false;
      const client = observed(async (query, phase, tx) => {
        if (query.startsWith("UPDATE cards SET") && phase === "after") {
          expect(await tx`SELECT archived FROM cards WHERE id=${cardId}`).toEqual([{ archived: true }]);
          expect(await tx`SELECT invalidated FROM opening_course_question_exposure_coverage WHERE workspace_id=${workspaceId}`)
            .toEqual([{ invalidated: true }]);
          updated = true;
          // Literal deliberately bypasses driver date normalization; PG executes it.
          await tx`SELECT '2026-02-30'::date`;
        }
      });
      await expect(createCardRepository(client).updateControls({ workspaceId, cardId, archived: true })).rejects.toMatchObject({ code: "22008" });
      expect(updated).toBe(true); expect(await history()).toEqual([]);
      expect({ card: await cardRows(), coverage: await coverage(), graph: await graphs(), facts: await facts() }).toEqual(before);
    });
  });

  it("rejects an idempotency key already used by another event type or card", async () => {
    const second = await cards.createCard({
      workspaceId,
      ownerUserId,
      front: "积分",
      back: "反导数",
      tags: ["高数"],
    });

    await events.append({
      workspaceId,
      ownerUserId,
      type: "attempt",
      idempotencyKey: "collision-key-01",
      occurredAt: "2026-08-15T05:00:00.000Z",
      contentId: cardId,
      contentVersion: 1,
      syllabusPointId: randomUUID(),
      payload: {
        answer: "A",
        correct: true,
        assisted: false,
        durationMs: 1000,
        hintCount: 0,
        confidence: 3,
        errorCause: null,
        abilitySlice: "procedure",
      },
    });

    await expect(
      cards.grade({
        workspaceId,
        ownerUserId,
        cardId,
        grade: "good",
        idempotencyKey: "collision-key-01",
        occurredAt: "2026-08-15T06:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    await cards.grade({
      workspaceId,
      ownerUserId,
      cardId,
      grade: "good",
      idempotencyKey: "shared-review-01",
      occurredAt: "2026-08-15T07:00:00.000Z",
    });
    await expect(
      cards.grade({
        workspaceId,
        ownerUserId,
        cardId: second.id,
        grade: "good",
        idempotencyKey: "shared-review-01",
        occurredAt: "2026-08-15T08:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const secondState = await cards.getState({
      workspaceId,
      ownerUserId,
      cardId: second.id,
    });
    expect(secondState).toMatchObject({ cardId: second.id });
  });
});
