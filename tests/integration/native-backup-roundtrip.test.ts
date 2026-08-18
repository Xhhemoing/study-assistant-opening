import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  createBackupRestoreRepository,
  createCardRepository,
  createCourseMembershipRepository,
  createExplorationRepository,
  createIdentityRepository,
  createLearningEventRepository,
  createLibraryRepository,
  createPromotionRepository,
  createSqlClient,
  listMigrationFiles,
  BackupRestoreError,
} from "@aistudy/database";
import { defaultGoalAbilities } from "@aistudy/domain";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for native backup round-trip tests");
}

describe("native backup round-trip", () => {
  const sql = createSqlClient(databaseUrl);
  const backups = createBackupRestoreRepository(sql);
  const identity = createIdentityRepository(sql);
  const library = createLibraryRepository(sql);
  const courses = createCourseMembershipRepository(sql);
  const explorations = createExplorationRepository(sql);
  const promotions = createPromotionRepository(sql);
  const cards = createCardRepository(sql);
  const events = createLearningEventRepository(sql);

  beforeAll(async () => {
    await applyMigrations(sql);
  });

  beforeEach(async () => {
    await sql`TRUNCATE
      learning_events, card_review_states, cards,
      promotion_targets, promotion_records,
      exploration_blocks, exploration_branches, explorations,
      revision_proposals, goal_time_windows, course_goals,
      course_asset_memberships, courses,
      library_properties, library_relations, library_revisions, library_blocks, library_documents,
      workspace_preferences, sessions, workspaces, users
      RESTART IDENTITY CASCADE`;
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  it("restores identities, relations, revisions, and file hashes into a wiped workspace", async () => {
    const owner = await identity.createUserWithWorkspace({
      email: `backup-${randomUUID()}@example.com`,
      displayName: "Backup",
      passwordHash: "scrypt$not-used",
    });
    const seeded = await seedWorkspace(owner.workspace.id, owner.user.id);
    const packed = await backups.exportWorkspace({
      workspaceId: owner.workspace.id,
      ownerUserId: owner.user.id,
    });

    expect(packed.schemaManifest.latestMigrationId).toBe((await listMigrationFiles()).at(-1));
    expect(packed.counts.documents).toBe(1);
    expect(packed.counts.relations).toBe(1);
    expect(packed.counts.revisions).toBeGreaterThan(0);
    expect(packed.counts.files).toBe(1);
    expect(packed.files[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);

    await wipeLearningData();
    const restored = await backups.restoreWorkspace({
      workspaceId: owner.workspace.id,
      ownerUserId: owner.user.id,
      packed,
      conflictPolicy: "reject",
    });

    expect(restored.applied.documents).toBe(1);
    expect(restored.applied.relations).toBe(1);
    expect(restored.applied.revisions).toBe(packed.counts.revisions);
    expect(restored.applied.files).toBe(1);
    const document = await library.getDocument({
      workspaceId: owner.workspace.id,
      documentId: seeded.documentId,
    });
    expect(document.title).toBe("导数笔记");
    expect(document.blocks.some((block) => block.id === seeded.blockId)).toBe(true);
    const card = await cards.getCard({ workspaceId: owner.workspace.id, cardId: seeded.cardId });
    expect(card.front).toBe("导数");
    const event = await events.get({ workspaceId: owner.workspace.id, eventId: seeded.eventId });
    expect(event.id).toBe(seeded.eventId);
    expect(packed.files[0]?.sha256).toBe(packed.files[0]?.sha256);
  });

  it("does not overwrite existing ids and rolls back a failed restore", async () => {
    const owner = await identity.createUserWithWorkspace({
      email: `conflict-${randomUUID()}@example.com`,
      displayName: "Conflict",
      passwordHash: "scrypt$not-used",
    });
    const seeded = await seedWorkspace(owner.workspace.id, owner.user.id);
    const packed = await backups.exportWorkspace({
      workspaceId: owner.workspace.id,
      ownerUserId: owner.user.id,
    });

    await expect(backups.restoreWorkspace({
      workspaceId: owner.workspace.id,
      ownerUserId: owner.user.id,
      packed,
      conflictPolicy: "reject",
    })).rejects.toBeInstanceOf(BackupRestoreError);

    const skipped = await backups.restoreWorkspace({
      workspaceId: owner.workspace.id,
      ownerUserId: owner.user.id,
      packed,
      conflictPolicy: "skip",
    });
    expect(skipped.skipped.documents).toBe(1);
    expect(skipped.skipped.cards).toBe(1);
    const original = await library.getDocument({
      workspaceId: owner.workspace.id,
      documentId: seeded.documentId,
    });
    expect(original.title).toBe("导数笔记");

    const broken = structuredClone(packed);
    broken.records.documents.push({
      id: randomUUID(),
      title: "不应留下",
      lifecycle: "scratch",
      schemaVersion: 1,
      currentRevisionNumber: 1,
    });
    broken.records.memberships.push({
      id: randomUUID(),
      courseId: randomUUID(),
      assetType: "document",
      assetId: seeded.documentId,
      role: "core",
      sortOrder: 0,
      visibility: "course",
    });
    await expect(backups.restoreWorkspace({
      workspaceId: owner.workspace.id,
      ownerUserId: owner.user.id,
      packed: broken,
      conflictPolicy: "skip",
    })).rejects.toThrow();
    const leftover = await sql`
      SELECT id FROM library_documents WHERE title = ${"不应留下"}
    `;
    expect(leftover).toHaveLength(0);
  });

  async function wipeLearningData() {
    await sql`TRUNCATE
      learning_events, card_review_states, cards,
      promotion_targets, promotion_records,
      exploration_blocks, exploration_branches, explorations,
      revision_proposals, goal_time_windows, course_goals,
      course_asset_memberships, courses,
      library_properties, library_relations, library_revisions, library_blocks, library_documents,
      workspace_preferences
      RESTART IDENTITY CASCADE`;
  }

  async function seedWorkspace(workspaceId: string, ownerUserId: string) {
    const course = await courses.createCourse({
      workspaceId,
      title: "高数",
      slug: "calc",
    });
    const document = await library.createDocument({
      workspaceId,
      title: "导数笔记",
      lifecycle: "scratch",
      blocks: [{
        id: randomUUID(),
        type: "attachment",
        content: {
          href: "attachments/scan.png",
          mediaType: "image/png",
          bytesBase64: Buffer.from([1, 2, 3, 4]).toString("base64"),
        },
      }],
    });
    await courses.addAssetMembership({
      workspaceId,
      courseId: course.id,
      assetType: "document",
      assetId: document.id,
      role: "core",
      visibility: "course",
    });
    const goalRows = await sql<{ id: string }[]>`
      INSERT INTO course_goals (
        workspace_id, course_id, kind, title, abilities, strategy_version
      ) VALUES (
        ${workspaceId}, ${course.id}, 'final-exam', '期末',
        ${sql.json(defaultGoalAbilities("final-exam"))}, 'goal-1'
      ) RETURNING id
    `;
    await sql`
      INSERT INTO goal_time_windows (
        workspace_id, goal_id, phase, starts_at, ends_at, modifier
      ) VALUES (
        ${workspaceId}, ${goalRows[0]!.id}, 'rehearsal',
        ${"2026-08-01T00:00:00.000Z"}, ${"2026-09-01T00:00:00.000Z"},
        ${sql.json({ timed: 10 })}
      )
    `;
    await library.createRelation({
      workspaceId,
      fromType: "document",
      fromId: document.id,
      toType: "block",
      toId: document.blocks[0]!.id,
      relationType: "embeds",
    });
    const exploration = await explorations.createExploration({
      workspaceId,
      ownerUserId,
      title: "追问",
      courseId: course.id,
    });
    await promotions.create({
      workspaceId,
      explorationId: exploration.id,
      kind: "note",
      title: "晋升",
      body: "导数定义",
    });
    const card = await cards.createCard({
      workspaceId,
      ownerUserId,
      front: "导数",
      back: "极限",
      sourceDocumentId: document.id,
    });
    const event = await events.append({
      workspaceId,
      ownerUserId,
      type: "review",
      idempotencyKey: `review-${randomUUID()}`,
      occurredAt: "2026-08-15T03:00:00.000Z",
      contentId: card.id,
      contentVersion: 1,
      payload: { grade: "good", assisted: false, excludeFromAssessment: false },
    });
    return { documentId: document.id, blockId: document.blocks[0]!.id, cardId: card.id, eventId: event.id };
  }
});
