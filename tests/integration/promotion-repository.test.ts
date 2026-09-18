import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  createCourseMembershipRepository,
  createExplorationRepository,
  createPromotionRepository,
  createSqlClient,
  type PromotionRepository,
} from "@aistudy/database";

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
    await sql`TRUNCATE promotion_targets, promotion_records, exploration_blocks, exploration_branches, explorations, course_asset_memberships, courses, library_revisions, library_blocks, library_documents, sessions, workspaces, users RESTART IDENTITY CASCADE`;
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
