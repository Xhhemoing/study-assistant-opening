import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  createIdentityRepository,
  createLearningEventRepository,
  lockWorkspaceLearningHistory,
  createPracticeContentRepository,
  createPracticeSessionRepository,
  createSqlClient,
  PracticeContentRepositoryError,
  type IdentityRepository,
  type PracticeContentRepository,
  type PracticeSessionRepository,
} from "@aistudy/database";
import type { Sql, TransactionSql } from "postgres";
import { submitAttemptForPrincipal } from "../../apps/web/src/features/practice/attempt-service";
import type { AuthRuntime } from "../../apps/web/src/features/auth/service";
import type { Principal } from "../../apps/web/src/lib/authorization";
import { openRaceSession } from "./opening-race-helpers";
import { assertHistoryWait, observeTransaction, signal } from "./outer-caller-history-fixture";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for practice content repository tests");
}

describe("practice content repository", () => {
  const sql = createSqlClient(databaseUrl);
  let identity: IdentityRepository;
  let content: PracticeContentRepository;
  let sessions: PracticeSessionRepository;
  let workspaceId: string;
  let ownerUserId: string;
  let otherWorkspaceId: string;
  let otherOwnerUserId: string;
  let packageId: string;
  let itemId: string;

  beforeAll(async () => {
    await applyMigrations(sql);
    identity = createIdentityRepository(sql);
    content = createPracticeContentRepository(sql);
    sessions = createPracticeSessionRepository(sql);
  });

  beforeEach(async () => {
    await sql`TRUNCATE
      practice_sessions, practice_item_versions, practice_items, syllabus_nodes, content_packages,
      sessions, workspaces, users
      RESTART IDENTITY CASCADE`;
    const owner = await identity.createUserWithWorkspace({
      email: `practice-a-${randomUUID()}@example.com`,
      displayName: "Practice owner",
      passwordHash: "scrypt$not-used",
    });
    const other = await identity.createUserWithWorkspace({
      email: `practice-b-${randomUUID()}@example.com`,
      displayName: "Other",
      passwordHash: "scrypt$not-used",
    });
    workspaceId = owner.workspace.id;
    ownerUserId = owner.user.id;
    otherWorkspaceId = other.workspace.id;
    otherOwnerUserId = other.user.id;
    ({ packageId, itemId } = await seedItem(sql, workspaceId));
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  const scope = () => ({ workspaceId, ownerUserId });
  const principal = () => ({ workspaceId, userId: ownerUserId }) as Principal;
  const runtime = (client = sql) => ({ sql: client, learningEvents: createLearningEventRepository(sql) }) as AuthRuntime;
  const body = (sessionId: string, key = "outer-submit-key") => ({
    practiceSessionId: sessionId, answer: "极限", confidence: 3, errorCause: null, idempotencyKey: key,
  });
  const history = () => sql`SELECT owner_user_id,revision FROM opening_workspace_history_revisions WHERE workspace_id=${workspaceId}`;

  it.each(["lazy", "nonzero", "other-workspace"])("outer submit history barrier %s preserves grading/replay/revision", async mode => {
    const session = await sessions.start({ workspaceId, ownerUserId, practiceItemId: itemId });
    await sessions.recordHint({ workspaceId, ownerUserId, sessionId: session.id });
    const courseId = randomUUID();
    await sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${courseId},${workspaceId},'Nonempty graph',${courseId})`;
    const snapshot = { nodes: [{ id: randomUUID(), label: "Existing concept" }], edges: [] };
    await sql`INSERT INTO opening_course_knowledge(workspace_id,owner_user_id,course_id,version,snapshot,source_versions)
      VALUES(${workspaceId},${ownerUserId},${courseId},1,${sql.json(snapshot)},'{}'::jsonb)`;
    if (mode !== "lazy") {
      await sql.begin(tx => lockWorkspaceLearningHistory(tx, scope()));
      await sql`UPDATE opening_workspace_history_revisions SET revision=19 WHERE workspace_id=${workspaceId}`;
    }
    const holder = openRaceSession(), writer = openRaceSession();
    const held = signal(), release = signal();
    let holderTx!: TransactionSql;
    let holding: Promise<unknown> | undefined, writing: Promise<unknown> | undefined;
    try {
      await Promise.all([holder.ready, writer.ready]);
      holding = holder.sql.begin(async tx => {
        await lockWorkspaceLearningHistory(tx, mode === "other-workspace"
          ? { workspaceId: otherWorkspaceId, ownerUserId: otherOwnerUserId } : scope());
        holderTx = tx; held.resolve(); await release.ready;
      });
      holding.catch(held.resolve);
      await Promise.race([held.ready, holding]);
      let finished = false;
      writing = submitAttemptForPrincipal(runtime(writer.sql), principal(), body(session.id));
      writing.then(() => { finished = true; }, () => { finished = true; });
      if (mode !== "other-workspace") {
        await assertHistoryWait(sql, writer.pid, holder.pid, () => finished);
        await holderTx`SELECT id FROM workspaces WHERE id=${workspaceId} FOR UPDATE NOWAIT`;
        await holderTx`SELECT id FROM practice_sessions WHERE id=${session.id} FOR UPDATE NOWAIT`;
        await holderTx`SELECT id FROM practice_items WHERE id=${itemId} FOR UPDATE NOWAIT`;
        expect(await sql`SELECT id FROM learning_events WHERE workspace_id=${workspaceId}`).toHaveLength(0);
        expect(await sql`SELECT submitted_at FROM practice_sessions WHERE id=${session.id}`).toEqual([{ submitted_at: null }]);
        release.resolve(); await holding;
      }
      await expect(writing).resolves.toMatchObject({ event: { correct: true, assisted: true, hintCount: 1, contentVersion: 2 } });
      const replay = await submitAttemptForPrincipal(runtime(), principal(), body(session.id));
      expect(replay.event).toMatchObject({ correct: true, assisted: true, hintCount: 1, contentVersion: 2 });
      await expect(submitAttemptForPrincipal(runtime(), principal(), body(session.id, "different-submit-key")))
        .rejects.toMatchObject({ code: "CONFLICT" });
      expect(await sql`SELECT id FROM learning_events WHERE workspace_id=${workspaceId}`).toHaveLength(1);
      expect(await history()).toEqual([{ owner_user_id: ownerUserId, revision: mode === "lazy" ? "0" : "19" }]);
      expect(await sql`SELECT snapshot FROM opening_course_knowledge WHERE course_id=${courseId}`).toEqual([{ snapshot }]);
    } finally {
      release.resolve();
      await Promise.allSettled([holding, writing].filter(Boolean));
      await Promise.all([holder.sql.end({ timeout: 5 }), writer.sql.end({ timeout: 5 })]);
    }
  });

  it("outer submit rolls back event, submitted flag and lazy history after a real SQL failure", async () => {
    const session = await sessions.start({ workspaceId, ownerUserId, practiceItemId: itemId });
    let updated = false;
    const client = observeTransaction(sql, async (query, tx) => {
      if (query.startsWith("UPDATE practice_sessions")) {
        expect(await tx`SELECT id FROM learning_events WHERE workspace_id=${workspaceId}`).toHaveLength(1);
        expect((await tx`SELECT submitted_at FROM practice_sessions WHERE id=${session.id}`)[0]!.submitted_at).not.toBeNull();
        updated = true;
        await tx`SELECT 1/0`;
      }
    });
    await expect(submitAttemptForPrincipal(runtime(client), principal(), body(session.id))).rejects.toMatchObject({ code: "22012" });
    expect(updated).toBe(true);
    expect(await sql`SELECT id FROM learning_events WHERE workspace_id=${workspaceId}`).toHaveLength(0);
    expect(await sql`SELECT submitted_at FROM practice_sessions WHERE id=${session.id}`).toEqual([{ submitted_at: null }]);
    expect(await history()).toEqual([]);
  });

  it("outer submit preserves owner/missing/UUID priority and does not ensure history on invalid input", async () => {
    const sessionId = randomUUID();
    await expect(submitAttemptForPrincipal(runtime(), { ...principal(), userId: otherOwnerUserId }, body(sessionId)))
      .rejects.toMatchObject({ code: "WORKSPACE_MISMATCH", message: "Practice session owner must match workspace owner" });
    await expect(submitAttemptForPrincipal(runtime(), principal(), body(sessionId)))
      .rejects.toMatchObject({ code: "NOT_FOUND", message: `Practice session ${sessionId} was not found` });
    await expect(submitAttemptForPrincipal(runtime(), { ...principal(), workspaceId: "bad-uuid" }, body(sessionId)))
      .rejects.toMatchObject({ code: "22P02" });
    expect(await history()).toEqual([]);
  });

  it("outer submit rejects session content drift after history without event or lazy counter", async () => {
    const session = await sessions.start({ workspaceId, ownerUserId, practiceItemId: itemId });
    let changed = false;
    const client = observeTransaction(sql, async query => {
      if (!changed && query.startsWith("SELECT revision FROM opening_workspace_history_revisions")) {
        changed = true;
        await sql`UPDATE practice_sessions SET content_version=1 WHERE id=${session.id}`;
      }
    });
    await expect(submitAttemptForPrincipal(runtime(client), principal(), body(session.id)))
      .rejects.toMatchObject({ code: "CONFLICT", message: "Practice session content changed while waiting for history" });
    expect(changed).toBe(true);
    expect(await history()).toEqual([]);
    expect(await sql`SELECT id FROM learning_events WHERE workspace_id=${workspaceId}`).toHaveLength(0);
    expect(await sql`SELECT submitted_at FROM practice_sessions WHERE id=${session.id}`).toEqual([{ submitted_at: null }]);
  });

  it.each(["owner", "deleted-session"])("outer submit safely rejects %s drift after history", async drift => {
    const session = await sessions.start({ workspaceId, ownerUserId, practiceItemId: itemId });
    if (drift === "owner") await sql`DELETE FROM workspaces WHERE id=${otherWorkspaceId}`;
    let changed = false;
    const client = observeTransaction(sql, async query => {
      if (!changed && query.startsWith("SELECT revision FROM opening_workspace_history_revisions")) {
        changed = true;
        if (drift === "owner") await sql`UPDATE workspaces SET owner_user_id=${otherOwnerUserId} WHERE id=${workspaceId}`;
        else await sql`DELETE FROM practice_sessions WHERE id=${session.id}`;
      }
    });
    await expect(submitAttemptForPrincipal(runtime(client), principal(), body(session.id)))
      .rejects.toMatchObject(drift === "owner"
        ? { code: "CONFLICT", message: "Practice session owner changed while waiting for history" }
        : { code: "NOT_FOUND", message: `Practice session ${session.id} was not found` });
    expect(changed).toBe(true);
    expect(await history()).toEqual([]);
    expect(await sql`SELECT id FROM learning_events WHERE workspace_id=${workspaceId}`).toHaveLength(0);
  });

  it("outer submit passes through real 55P03 and rolls back lazy history", async () => {
    const session = await sessions.start({ workspaceId, ownerUserId, practiceItemId: itemId });
    const blocker = openRaceSession(), held = signal(), release = signal();
    let holding: Promise<unknown> | undefined;
    try {
      await blocker.ready;
      holding = blocker.sql.begin(async tx => {
        await tx`SELECT id FROM practice_sessions WHERE id=${session.id} FOR UPDATE`;
        held.resolve(); await release.ready;
      });
      holding.catch(held.resolve); await Promise.race([held.ready, holding]);
      const client = observeTransaction(sql, async (query, tx) => {
        if (query.startsWith("SELECT revision FROM opening_workspace_history_revisions")) {
          await tx`SELECT id FROM practice_sessions WHERE id=${session.id} FOR UPDATE NOWAIT`;
        }
      });
      await expect(submitAttemptForPrincipal(runtime(client), principal(), body(session.id))).rejects.toMatchObject({ code: "55P03" });
      expect(await history()).toEqual([]);
      expect(await sql`SELECT id FROM learning_events WHERE workspace_id=${workspaceId}`).toHaveLength(0);
    } finally { release.resolve(); await holding; await blocker.sql.end({ timeout: 5 }); }
  });

  it("keeps package and item reads inside the principal workspace", async () => {
    const item = await content.getPublicItem({ workspaceId, itemId });
    expect(item.stem).toBe("当前版本题干");
    await expect(content.getPublicItem({ workspaceId: otherWorkspaceId, itemId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const points = await content.listSyllabusPoints({ workspaceId, packageId });
    expect(points.map((point) => point.code)).toEqual(["D1"]);
    expect(await content.listPracticeCandidates({ workspaceId: otherWorkspaceId, packageId })).toEqual([]);
  });

  it("reads current and historical versions and omits answers from the public item", async () => {
    const publicItem = await content.getPublicItem({ workspaceId, itemId });
    expect(publicItem.contentVersion).toBe(2);
    expect(publicItem).not.toHaveProperty("answer");
    expect(publicItem).not.toHaveProperty("answerRule");
    const current = await content.getGradableVersion({ workspaceId, itemId, version: 2 });
    const historical = await content.getGradableVersion({ workspaceId, itemId, version: 1 });
    expect(current.answerRule).toEqual({ type: "exact", accepted: ["极限"] });
    expect(historical.answerDisplay).toBe("旧答案");
    expect(historical.contentVersion).toBe(1);
  });

  it("starts a session bound to the principal, item, and current version", async () => {
    const session = await sessions.start({ workspaceId, ownerUserId, practiceItemId: itemId });
    expect(session).toMatchObject({
      workspaceId,
      ownerUserId,
      practiceItemId: itemId,
      contentVersion: 2,
      hintCount: 0,
      answerRevealedAt: null,
      submittedAt: null,
    });
  });

  it("increments hint counts on the server and records answer reveal", async () => {
    const session = await sessions.start({ workspaceId, ownerUserId, practiceItemId: itemId });
    const first = await sessions.recordHint({ workspaceId, ownerUserId, sessionId: session.id });
    const second = await sessions.recordHint({ workspaceId, ownerUserId, sessionId: session.id });
    expect(first.hint).toBe("提示一");
    expect(second.hint).toBe("提示二");
    expect(second.session.hintCount).toBe(2);
    const revealed = await sessions.recordAnswerReveal({
      workspaceId,
      ownerUserId,
      sessionId: session.id,
    });
    expect(revealed.answerRevealedAt).toEqual(expect.any(String));
  });

  it("rejects a different idempotency key after the session is submitted", async () => {
    const session = await sessions.start({ workspaceId, ownerUserId, practiceItemId: itemId });
    const first = await sessions.markSubmitted({
      workspaceId,
      ownerUserId,
      sessionId: session.id,
      idempotencyKey: "attempt-submit-01",
    });
    const replay = await sessions.markSubmitted({
      workspaceId,
      ownerUserId,
      sessionId: session.id,
      idempotencyKey: "attempt-submit-01",
    });
    expect(replay.submittedAt).toBe(first.submittedAt);
    await expect(
      sessions.markSubmitted({
        workspaceId,
        ownerUserId,
        sessionId: session.id,
        idempotencyKey: "attempt-submit-02",
      }),
    ).rejects.toBeInstanceOf(PracticeContentRepositoryError);
  });

  it("blocks new sessions for archived items while historical versions stay readable", async () => {
    await sql`UPDATE practice_items SET archived_at = now() WHERE id = ${itemId}`;
    await expect(sessions.start({ workspaceId, ownerUserId, practiceItemId: itemId })).rejects.toMatchObject({
      code: "ARCHIVED",
    });
    const historical = await content.getGradableVersion({ workspaceId, itemId, version: 1 });
    expect(historical.answerDisplay).toBe("旧答案");
  });
});

async function seedItem(sql: Sql, workspaceId: string) {
  const packageId = randomUUID();
  const pointId = randomUUID();
  const itemId = randomUUID();
  await sql`
    INSERT INTO content_packages (id, workspace_id, title, version, status)
    VALUES (${packageId}, ${workspaceId}, ${"高数试点"}, 1, ${"active"})
  `;
  await sql`
    INSERT INTO syllabus_nodes (id, workspace_id, package_id, parent_id, code, title, sort_order)
    VALUES (${pointId}, ${workspaceId}, ${packageId}, null, ${"D1"}, ${"导数定义"}, 1)
  `;
  await sql`
    INSERT INTO practice_items (id, workspace_id, package_id, current_version)
    VALUES (${itemId}, ${workspaceId}, ${packageId}, 2)
  `;
  await sql`
    INSERT INTO practice_item_versions (
      practice_item_id, version, workspace_id, syllabus_point_id, kind, stem, options,
      answer_rule, answer_display, hints, ability_slice, estimated_minutes, source, review_status
    ) VALUES (
      ${itemId}, 1, ${workspaceId}, ${pointId}, ${"short_answer"}, ${"旧题干"}, null,
      ${sql.json({ type: "exact", accepted: ["旧答案"] })}, ${"旧答案"}, ${sql.json([])},
      ${"recall"}, 5, ${sql.json({ origin: "pilot" })}, ${"reviewed"}
    )
  `;
  await sql`
    INSERT INTO practice_item_versions (
      practice_item_id, version, workspace_id, syllabus_point_id, kind, stem, options,
      answer_rule, answer_display, hints, ability_slice, estimated_minutes, source, review_status
    ) VALUES (
      ${itemId}, 2, ${workspaceId}, ${pointId}, ${"short_answer"}, ${"当前版本题干"}, null,
      ${sql.json({ type: "exact", accepted: ["极限"] })}, ${"极限"},
      ${sql.json(["提示一", "提示二"])}, ${"recall"}, 5, ${sql.json({ origin: "pilot" })}, ${"reviewed"}
    )
  `;
  return { packageId, pointId, itemId };
}
