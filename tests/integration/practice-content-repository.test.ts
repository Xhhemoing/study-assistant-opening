import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  createIdentityRepository,
  createPracticeContentRepository,
  createPracticeSessionRepository,
  createSqlClient,
  PracticeContentRepositoryError,
  type IdentityRepository,
  type PracticeContentRepository,
  type PracticeSessionRepository,
} from "@aistudy/database";
import type { Sql } from "postgres";

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
  let packageId: string;
  let pointId: string;
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
    ({ packageId, pointId, itemId } = await seedItem(sql, workspaceId));
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
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
