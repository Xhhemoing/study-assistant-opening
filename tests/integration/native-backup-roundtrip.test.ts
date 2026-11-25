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
  createOpeningNoteRepository,
  createPromotionRepository,
  createScopedOpeningSystemQueryReader,
  createSqlClient,
  listMigrationFiles,
  readOpeningBackupRecords,
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
      opening_learning_observations, opening_learning_attempts, opening_learning_item_versions, opening_learning_sessions,
      opening_teaching_activity_specs, opening_teaching_units, opening_teaching_activities,
      opening_note_provenance, opening_privacy_exclusions, opening_sources,
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

  it("omits answers marked only in block content from learner exports and revision snapshots", async () => {
    const owner = await identity.createUserWithWorkspace({
      email: `backup-${randomUUID()}@example.com`, displayName: "Backup", passwordHash: "scrypt$not-used",
    });
    const scope = { workspaceId: owner.workspace.id, ownerUserId: owner.user.id };
    const visible = { id: randomUUID(), type: "paragraph", content: { text: "Public lesson" } };
    await library.createDocument({ workspaceId: scope.workspaceId, title: "Lesson", blocks: [
      visible,
      { id: randomUUID(), type: "text", content: { role: "answer_key", text: "Private answer" } },
      { id: randomUUID(), type: "text", content: { blockType: "solution", text: "Private solution" } },
    ] });

    const { records } = await backups.exportWorkspace(scope);
    const { tables } = await readOpeningBackupRecords(sql, scope);
    for (const blocks of [records.blocks, tables.library_blocks]) {
      expect(blocks).toMatchObject([visible]);
    }
    for (const revisions of [records.revisions, tables.library_revisions]) {
      expect(revisions).toMatchObject([{ blocks: [visible] }]);
    }
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

  it("drops all corrections of an excluded review and restores the retained chain into an empty workspace", async () => {
    const owner = await identity.createUserWithWorkspace({
      email: `corrections-${randomUUID()}@example.com`, displayName: "Backup", passwordHash: "scrypt$not-used",
    });
    const scope = { workspaceId: owner.workspace.id, ownerUserId: owner.user.id };
    const { workspaceId, ownerUserId } = scope;
    const source = randomUUID(), hiddenCard = randomUUID(), visibleCard = randomUUID();
    await sql`INSERT INTO opening_sources (id,workspace_id,name,mime,bytes,sha256,upload_state,parse_state)
      VALUES(${source},${workspaceId},'Study source','text/plain',1,${"0".repeat(64)},'uploaded','ready')`;
    await sql`INSERT INTO cards(id,workspace_id,owner_user_id,front,back,source_ids) VALUES
      (${hiddenCard},${workspaceId},${ownerUserId},'Private prompt','Private answer',${[source]}),
      (${visibleCard},${workspaceId},${ownerUserId},'Public prompt','Public answer','{}')`;

    async function reviewChain(card: string, note: string) {
      const review = randomUUID(), correction = randomUUID(), followup = randomUUID();
      await sql`INSERT INTO learning_events (id,workspace_id,owner_user_id,type,schema_version,idempotency_key,occurred_at,content_id,content_version,payload)
        VALUES(${review},${workspaceId},${ownerUserId},'review',1,${review},now(),${card},1,'{"grade":"good"}')`;
      for (const [id, parent] of [[correction, review], [followup, correction]] as const) {
        await sql`INSERT INTO learning_events (id,workspace_id,owner_user_id,type,schema_version,idempotency_key,occurred_at,corrects_event_id,payload)
          VALUES(${id},${workspaceId},${ownerUserId},'correction',1,${id},now(),${parent},${sql.json({ note })})`;
      }
      return [review, correction, followup];
    }

    const hiddenChain = await reviewChain(hiddenCard, "Private correction text");
    const visibleChain = await reviewChain(visibleCard, "Retained correction text");
    expect((await backups.exportWorkspace(scope)).counts.events).toBe(6);
    await sql`INSERT INTO opening_privacy_exclusions(workspace_id,source_id,deleted_at) VALUES(${workspaceId},${source},now())`;
    const packed = await backups.exportWorkspace(scope);
    expect(packed.records.events.map(row => row.id)).toEqual(visibleChain);
    expect(JSON.stringify(packed)).not.toContain("Private correction text");

    const target = await identity.createUserWithWorkspace({
      email: `target-${randomUUID()}@example.com`, displayName: "Backup target", passwordHash: "scrypt$not-used",
    });
    // Restore must also work for archives in which children precede parents.
    packed.records.events.reverse();
    await sql`TRUNCATE learning_events`;
    await sql`DELETE FROM cards WHERE workspace_id=${workspaceId}`;
    const restored = await backups.restoreWorkspace({
      workspaceId: target.workspace.id, ownerUserId: target.user.id, packed, conflictPolicy: "reject",
    });
    expect(restored.applied).toMatchObject({ cards: 1, events: 3 });
    const retained = await sql`SELECT id,corrects_event_id FROM learning_events WHERE workspace_id=${target.workspace.id}`;
    expect(retained).toHaveLength(3);
    expect(retained).toEqual(expect.arrayContaining(visibleChain.map((id, index) => ({
      id, corrects_event_id: visibleChain[index - 1] ?? null,
    }))));
    for (const id of hiddenChain) expect(retained.map(row => row.id)).not.toContain(id);
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

  it.each(["blocks", "revisions", "memberships", "relations"] as const)("rejects forged %s pointing at another workspace without mutating the victim", async (collection) => {
    const victim = await identity.createUserWithWorkspace({ email: `${randomUUID()}@example.com`, displayName: "Victim", passwordHash: "unused" });
    const attacker = await identity.createUserWithWorkspace({ email: `${randomUUID()}@example.com`, displayName: "Attacker", passwordHash: "unused" });
    const seeded = await seedWorkspace(victim.workspace.id, victim.user.id);
    const victimPackage = await backups.exportWorkspace({ workspaceId: victim.workspace.id, ownerUserId: victim.user.id });
    const packed = await backups.exportWorkspace({ workspaceId: attacker.workspace.id, ownerUserId: attacker.user.id });
    packed.records[collection] = [{ ...victimPackage.records[collection][0]!, id: randomUUID() }];
    await expect(backups.restoreWorkspace({ workspaceId: attacker.workspace.id, ownerUserId: attacker.user.id,
      packed, conflictPolicy: "skip" })).rejects.toMatchObject({ code: "VALIDATION" });
    expect((await library.getDocument({ workspaceId: victim.workspace.id, documentId: seeded.documentId })).title).toBe("导数笔记");
    const [count] = await sql`SELECT count(*)::integer AS count FROM library_revisions WHERE document_id=${seeded.documentId}`;
    expect(count!.count).toBe(victimPackage.counts.revisions);
    const [attackerCount] = await sql`SELECT count(*)::integer AS count FROM library_blocks WHERE workspace_id=${attacker.workspace.id}`;
    expect(attackerCount!.count).toBe(0);
  });

  it.each(["skip", "reject"] as const)("does not disclose foreign id conflicts through %s results", async conflictPolicy => {
    const victim = await identity.createUserWithWorkspace({ email: `${randomUUID()}@example.com`, displayName: "Victim", passwordHash: "unused" });
    const attacker = await identity.createUserWithWorkspace({ email: `${randomUUID()}@example.com`, displayName: "Attacker", passwordHash: "unused" });
    const document = await library.createDocument({ workspaceId: victim.workspace.id, title: "private", lifecycle: "scratch",
      blocks: [{ id: randomUUID(), type: "paragraph", content: { text: "private victim content" } }] });
    const packed = await backups.exportWorkspace({ workspaceId: attacker.workspace.id, ownerUserId: attacker.user.id });
    packed.records.documents = [{ id: document.id, title: "forged", lifecycle: "scratch", schemaVersion: 1, currentRevisionNumber: 1, openingProvenance: null }];
    await expect(backups.restoreWorkspace({ workspaceId: attacker.workspace.id, ownerUserId: attacker.user.id, packed, conflictPolicy }))
      .rejects.toMatchObject({ code: "VALIDATION", message: "Backup records conflict with the target workspace or contain invalid references" });
    expect(await library.getDocument({ workspaceId: victim.workspace.id, documentId: document.id })).toEqual(document);
    const [attackerCount] = await sql`SELECT count(*)::integer AS count FROM library_documents WHERE workspace_id=${attacker.workspace.id}`;
    expect(attackerCount!.count).toBe(0);
  });

  it("preserves legitimate broken links and historical learning identities", async () => {
    const owner = await identity.createUserWithWorkspace({ email: `${randomUUID()}@example.com`, displayName: "History", passwordHash: "unused" });
    const seeded = await seedWorkspace(owner.workspace.id, owner.user.id);
    // Removing a block is a supported edit; its existing relation remains broken.
    await sql`DELETE FROM library_blocks WHERE id=${seeded.blockId}`;
    const historicalContentId = randomUUID();
    const historicalPointId = randomUUID();
    await events.append({ workspaceId: owner.workspace.id, ownerUserId: owner.user.id,
      type: "attempt", idempotencyKey: `history-${randomUUID()}`, occurredAt: "2026-08-15T03:00:00.000Z",
      contentId: historicalContentId, contentVersion: 1, syllabusPointId: historicalPointId,
      payload: { answer: "1", correct: true, assisted: false, durationMs: 1000,
        hintCount: 0, confidence: 3, errorCause: null, abilitySlice: "recognition" } });
    const packed = await backups.exportWorkspace({ workspaceId: owner.workspace.id, ownerUserId: owner.user.id });
    await wipeLearningData();
    const restored = await backups.restoreWorkspace({ workspaceId: owner.workspace.id, ownerUserId: owner.user.id, packed, conflictPolicy: "reject" });
    expect(restored.applied.relations).toBe(1);
    const [event] = await sql`SELECT content_id,syllabus_point_id FROM learning_events
      WHERE workspace_id=${owner.workspace.id} AND type='attempt'`;
    expect(event).toMatchObject({ content_id: historicalContentId, syllabus_point_id: historicalPointId });
    expect(await sql`SELECT id FROM library_blocks WHERE id=${seeded.blockId}`).toHaveLength(0);
  });

  it("withholds a note carrying malformed nested-array lineage from native export matching openingNoteReadable and readOpeningBackupRecords", async () => {
    const owner = await identity.createUserWithWorkspace({
      email: `malformed-note-${randomUUID()}@example.com`,
      displayName: "Malformed Note",
      passwordHash: "unused",
    });
    const scope = { workspaceId: owner.workspace.id, ownerUserId: owner.user.id };
    const sourceId = randomUUID();
    await sql`INSERT INTO opening_sources(id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state)
      VALUES(${sourceId},${scope.workspaceId},'source.txt','text/plain',1,${"b".repeat(64)},1,'uploaded','ready')`;

    const badNote = await library.createDocument({
      workspaceId: scope.workspaceId,
      title: "MALFORMED-LINEAGE-TITLE",
      lifecycle: "scratch",
      blocks: [{ id: randomUUID(), type: "paragraph", content: { text: "MALFORMED-LINEAGE-BODY" } }],
    });
    const cleanNote = await library.createDocument({
      workspaceId: scope.workspaceId,
      title: "CLEAN-ORDINARY-NOTE",
      lifecycle: "scratch",
      blocks: [{ id: randomUUID(), type: "paragraph", content: { text: "CLEAN-ORDINARY-BODY" } }],
    });
    const directCard = await cards.createCard({
      workspaceId: scope.workspaceId,
      ownerUserId: scope.ownerUserId,
      front: "MALFORMED-DIRECT-CARD",
      back: "MALFORMED-DIRECT-BACK",
      sourceDocumentId: badNote.id,
    });
    const pubCard = await cards.createCard({
      workspaceId: scope.workspaceId,
      ownerUserId: scope.ownerUserId,
      front: "MALFORMED-PUB-CARD",
      back: "MALFORMED-PUB-BACK",
    });
    const cleanCard = await cards.createCard({
      workspaceId: scope.workspaceId,
      ownerUserId: scope.ownerUserId,
      front: "CLEAN-CARD",
      back: "CLEAN-BACK",
    });
    const badReview = await events.append({
      workspaceId: scope.workspaceId,
      ownerUserId: scope.ownerUserId,
      type: "review",
      idempotencyKey: `bad-review-${randomUUID()}`,
      occurredAt: "2026-08-15T03:00:00.000Z",
      contentId: directCard.id,
      contentVersion: 1,
      payload: { grade: "good", assisted: false, excludeFromAssessment: false },
    });
    const pubReview = await events.append({
      workspaceId: scope.workspaceId,
      ownerUserId: scope.ownerUserId,
      type: "review",
      idempotencyKey: `pub-review-${randomUUID()}`,
      occurredAt: "2026-08-15T03:00:00.000Z",
      contentId: pubCard.id,
      contentVersion: 1,
      payload: { grade: "good", assisted: false, excludeFromAssessment: false },
    });

    for (const malformedSourceRef of [
      { sourceId, sourceVersion: 1, legacy: [] },
      { sourceId, sourceVersion: 1, publication: "legacy" },
      { sourceId, sourceVersion: 1, publication: false },
    ]) {
      await sql`INSERT INTO opening_note_provenance(document_id,workspace_id,context_source_refs)
        VALUES(${badNote.id},${scope.workspaceId},${sql.json([
          malformedSourceRef,
          { publicationCardIds: [pubCard.id] },
        ])})
        ON CONFLICT (document_id) DO UPDATE SET context_source_refs=EXCLUDED.context_source_refs`;

      await expect(library.getDocument({ workspaceId: scope.workspaceId, documentId: badNote.id }))
        .rejects.toMatchObject({ code: "NOT_FOUND" });

      const openingSnapshot = await readOpeningBackupRecords(sql, scope);
      const nativePacked = await backups.exportWorkspace(scope);

      expect(openingSnapshot.tables.library_documents.map(row => row.id)).toEqual([cleanNote.id]);
      expect(openingSnapshot.tables.cards.map(row => row.id)).toEqual([cleanCard.id]);
      expect(nativePacked.records.documents.map(row => row.id)).toEqual([cleanNote.id]);
      expect(nativePacked.records.cards.map(row => row.id)).toEqual([cleanCard.id]);
      expect(nativePacked.records.events).toEqual([]);

      for (const serialized of [JSON.stringify(openingSnapshot.tables), JSON.stringify(nativePacked)]) {
        for (const forbidden of [
          badNote.id,
          "MALFORMED-LINEAGE-TITLE",
          "MALFORMED-LINEAGE-BODY",
          directCard.id,
          "MALFORMED-DIRECT-CARD",
          pubCard.id,
          "MALFORMED-PUB-CARD",
          badReview.id,
          pubReview.id,
        ]) {
          expect(serialized).not.toContain(forbidden);
        }
      }
    }

    const nativePacked = await backups.exportWorkspace(scope);
    await wipeLearningData();
    for (const badRefs of [
      [{ sourceId, sourceVersion: 1, legacy: [] }],
      [{ sourceId, sourceVersion: 1, publication: "legacy" }],
      [{ sourceId, sourceVersion: 1, publication: false }],
    ]) {
      const forged = structuredClone(nativePacked);
      (forged.records.documents[0] as Record<string, unknown>).openingProvenance = { contextSourceRefs: badRefs };
      await expect(backups.restoreWorkspace({ ...scope, packed: forged, conflictPolicy: "reject" }))
        .rejects.toMatchObject({ code: "VALIDATION" });
    }
  });

  it.each(["source-backed", "turn-memory-backed"] as const)(
    "rejects foreign-workspace child-only restores targeting a retained %s linked note without mutating the target workspace",
    async noteKind => {
      const target = await identity.createUserWithWorkspace({
        email: `target-${noteKind}-${randomUUID()}@example.com`,
        displayName: "Target",
        passwordHash: "unused",
      });
      const foreign = await identity.createUserWithWorkspace({
        email: `foreign-${noteKind}-${randomUUID()}@example.com`,
        displayName: "Foreign",
        passwordHash: "unused",
      });
      const targetScope = { workspaceId: target.workspace.id, ownerUserId: target.user.id };
      const foreignBase = await backups.exportWorkspace({ workspaceId: foreign.workspace.id, ownerUserId: foreign.user.id });

      const targetCourse = await courses.createCourse({
        workspaceId: targetScope.workspaceId,
        title: "Target Course",
        slug: `course-${randomUUID()}`,
      });
      const plainDoc = await library.createDocument({
        workspaceId: targetScope.workspaceId,
        title: "Plain Note",
        lifecycle: "scratch",
        blocks: [{ id: randomUUID(), type: "paragraph", content: { text: "Plain body" } }],
      });
      const targetExploration = await explorations.createExploration({
        workspaceId: targetScope.workspaceId,
        ownerUserId: targetScope.ownerUserId,
        title: "Target Exploration",
        courseId: targetCourse.id,
      });

      const notes = createOpeningNoteRepository(sql);
      let linkedDocId: string;
      if (noteKind === "source-backed") {
        const sourceId = randomUUID();
        const convId = randomUUID();
        const turnId = randomUUID();
        await sql`INSERT INTO opening_sources(id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state)
          VALUES(${sourceId},${targetScope.workspaceId},'source.txt','text/plain',1,${"c".repeat(64)},0,'uploaded','ready')`;
        await sql`INSERT INTO opening_conversations(id,workspace_id,owner_user_id,title)
          VALUES(${convId},${targetScope.workspaceId},${targetScope.ownerUserId},'Source dialogue')`;
        await sql`INSERT INTO opening_turns(id,workspace_id,conversation_id,role,text,mode,status,context_source_refs)
          VALUES(${turnId},${targetScope.workspaceId},${convId},'assistant','Source answer','listen','complete',
            ${sql.json([{ sourceId, sourceVersion: 0 }])})`;
        ({ documentId: linkedDocId } = await notes.saveSnippet(targetScope, {
          title: "Retained source note",
          text: "Retained source body",
          savedTurnId: turnId,
        }));
      } else {
        const convId = randomUUID();
        const userTurnId = randomUUID();
        const assistantTurnId = randomUUID();
        const memoryId = randomUUID();
        await sql`INSERT INTO opening_conversations(id,workspace_id,owner_user_id,title)
          VALUES(${convId},${targetScope.workspaceId},${targetScope.ownerUserId},'Memory dialogue')`;
        await sql`INSERT INTO opening_turns(id,workspace_id,conversation_id,role,text,mode,status,context_source_refs)
          VALUES(${userTurnId},${targetScope.workspaceId},${convId},'user','User memory','listen','complete','[]'::jsonb)`;
        await sql`INSERT INTO opening_memories(id,workspace_id,kind,text,source_turn_ids,status)
          VALUES(${memoryId},${targetScope.workspaceId},'confirmed','Confirmed memory',${sql.json([userTurnId])},'active')`;
        await sql`INSERT INTO opening_turns(id,workspace_id,conversation_id,role,text,mode,status,context_source_refs)
          VALUES(${assistantTurnId},${targetScope.workspaceId},${convId},'assistant','Memory answer','listen','complete',
            ${sql.json([{ memoryDependencyIds: [memoryId] }])})`;
        ({ documentId: linkedDocId } = await notes.saveSnippet(targetScope, {
          title: "Retained memory note",
          text: "Retained memory body",
          savedTurnId: assistantTurnId,
        }));
      }

      const linkedDoc = await library.getDocument({ workspaceId: targetScope.workspaceId, documentId: linkedDocId });
      const retainedBlockId = linkedDoc.blocks[0]!.id;

      const snapshotTargetCounts = async () => {
        const [counts] = await sql`SELECT
          (SELECT count(*)::int FROM library_documents WHERE workspace_id=${targetScope.workspaceId}) AS docs,
          (SELECT count(*)::int FROM library_blocks WHERE workspace_id=${targetScope.workspaceId}) AS blocks,
          (SELECT count(*)::int FROM library_revisions WHERE workspace_id=${targetScope.workspaceId}) AS revisions,
          (SELECT count(*)::int FROM cards WHERE workspace_id=${targetScope.workspaceId}) AS cards,
          (SELECT count(*)::int FROM course_asset_memberships WHERE workspace_id=${targetScope.workspaceId}) AS memberships,
          (SELECT count(*)::int FROM library_relations WHERE workspace_id=${targetScope.workspaceId}) AS relations,
          (SELECT count(*)::int FROM promotion_records WHERE workspace_id=${targetScope.workspaceId}) AS promotions,
          (SELECT count(*)::int FROM promotion_targets WHERE workspace_id=${targetScope.workspaceId}) AS promotion_targets`;
        return counts;
      };
      const baseline = await snapshotTargetCounts();

      const childMutations: Array<Record<string, unknown[]>> = [
        {
          blocks: [{
            id: randomUUID(),
            documentId: linkedDocId,
            type: "paragraph",
            position: 99,
            content: { text: "forged child block" },
          }],
        },
        {
          revisions: [{
            id: randomUUID(),
            documentId: linkedDocId,
            revisionNumber: 99,
            parentRevisionNumber: 1,
            title: "Forged revision",
            lifecycle: "scratch",
            reason: "edit",
            blocks: [],
          }],
        },
        {
          cards: [{
            id: randomUUID(),
            ownerUserId: foreign.user.id,
            front: "Forged front",
            back: "Forged back",
            sourceDocumentId: linkedDocId,
            sourceIds: [],
            tags: [],
            archived: false,
            contentVersion: 1,
            autoPaused: false,
            excludeFromAssessment: false,
          }],
        },
        {
          memberships: [{
            id: randomUUID(),
            courseId: targetCourse.id,
            assetType: "document",
            assetId: linkedDocId,
            role: "core",
            sortOrder: 0,
            visibility: "course",
          }],
        },
        {
          relations: [{
            id: randomUUID(),
            fromType: "document",
            fromId: plainDoc.id,
            toType: "document",
            toId: linkedDocId,
            relationType: "references",
            source: { kind: "user" },
          }],
        },
        {
          relations: [{
            id: randomUUID(),
            fromType: "document",
            fromId: plainDoc.id,
            toType: "block",
            toId: retainedBlockId,
            relationType: "embeds",
            source: { kind: "user" },
          }],
        },
        {
          promotions: [{
            id: randomUUID(),
            explorationId: targetExploration.id,
            kind: "note",
            title: "Forged promotion",
            body: "Forged body",
            status: "accepted",
            targetType: "document",
            targetId: linkedDocId,
          }],
        },
        {
          promotions: (() => {
            const promoId = randomUUID();
            return [{
              id: promoId,
              explorationId: targetExploration.id,
              kind: "note",
              title: "Forged nested target promotion",
              body: "Forged body",
              status: "pending",
              targets: [{
                id: randomUUID(),
                promotionId: promoId,
                explorationId: targetExploration.id,
                kind: "note",
                title: "Forged target",
                body: "Forged target body",
                targetId: retainedBlockId,
              }],
            }];
          })(),
        },
      ];

      for (const mutation of childMutations) {
        const packed = structuredClone(foreignBase);
        packed.records.documents = [];
        Object.assign(packed.records, mutation);
        const attempt = backups.restoreWorkspace({
          ...targetScope,
          packed,
          conflictPolicy: "skip",
        });
        await expect(attempt).rejects.toBeInstanceOf(BackupRestoreError);
        await expect(attempt).rejects.toMatchObject({
          code: "VALIDATION",
          message: expect.stringContaining("original workspace"),
        });
        expect(await snapshotTargetCounts()).toEqual(baseline);
      }
    },
  );

  it("preserves and revalidates source-free snippet lineage across native export, wipe, restore, system queries, and skip merges", async () => {
    const owner = await identity.createUserWithWorkspace({
      email: `snippet-roundtrip-${randomUUID()}@example.com`,
      displayName: "Snippet Roundtrip",
      passwordHash: "unused",
    });
    const scope = { workspaceId: owner.workspace.id, ownerUserId: owner.user.id };
    const conversationId = randomUUID();
    const userTurnId = randomUUID();
    const assistantTurnId = randomUUID();
    const memoryId = randomUUID();

    await sql`INSERT INTO opening_conversations(id,workspace_id,owner_user_id,title)
      VALUES(${conversationId},${scope.workspaceId},${scope.ownerUserId},'Memory dialogue')`;
    await sql`INSERT INTO opening_turns(id,workspace_id,conversation_id,role,text,mode,status,context_source_refs)
      VALUES(${userTurnId},${scope.workspaceId},${conversationId},'user','Remember my algebra rule','listen','complete','[]'::jsonb)`;
    await sql`INSERT INTO opening_memories(id,workspace_id,kind,text,source_turn_ids,status)
      VALUES(${memoryId},${scope.workspaceId},'confirmed','Confirmed algebra memory',${sql.json([userTurnId])},'active')`;
    await sql`INSERT INTO opening_turns(id,workspace_id,conversation_id,role,text,mode,status,context_source_refs)
      VALUES(${assistantTurnId},${scope.workspaceId},${conversationId},'assistant','Explanation using memory','listen','complete',
        ${sql.json([{ memoryDependencyIds: [memoryId] }])})`;
    await sql`INSERT INTO opening_tutor_jobs(id,workspace_id,conversation_id,user_turn_id,assistant_turn_id,status,mode)
      VALUES(${randomUUID()},${scope.workspaceId},${conversationId},${userTurnId},${assistantTurnId},'succeeded','listen')`;

    const notes = createOpeningNoteRepository(sql);
    const { documentId } = await notes.saveSnippet(scope, {
      title: "Memory-backed snippet",
      text: "PRIVATE-SNIPPET-BODY",
      savedTurnId: assistantTurnId,
    });
    const expectedOriginTurnIds = [assistantTurnId, userTurnId].sort();
    const expectedDbProvenance = [
      { memoryDependencyIds: [memoryId] },
      { snippetLineageVersion: 1 },
      { originTurnIds: expectedOriginTurnIds },
    ];
    expect((await sql`SELECT context_source_refs FROM opening_note_provenance WHERE document_id=${documentId}`)[0]!.context_source_refs)
      .toEqual(expectedDbProvenance);

    const packed = await backups.exportWorkspace(scope);
    expect(packed.records.documents).toHaveLength(1);
    expect(packed.records.documents[0]!.openingProvenance).toEqual({
      contextSourceRefs: [],
      memoryDependencyIds: [memoryId],
      originTurnIds: expectedOriginTurnIds,
      snippetLineageVersion: 1,
    });

    const other = await identity.createUserWithWorkspace({
      email: `other-snippet-${randomUUID()}@example.com`,
      displayName: "Other",
      passwordHash: "unused",
    });
    const crossPacked = structuredClone(packed);
    const crossDocId = randomUUID();
    const crossBlockId = randomUUID();
    (crossPacked.records.documents[0] as Record<string, unknown>).id = crossDocId;
    for (const block of crossPacked.records.blocks) {
      Object.assign(block as object, { id: crossBlockId, documentId: crossDocId });
    }
    for (const rev of crossPacked.records.revisions) {
      const record = rev as Record<string, unknown>;
      Object.assign(record, { id: randomUUID(), documentId: crossDocId });
      for (const block of record.blocks as Array<Record<string, unknown>>) block.id = crossBlockId;
    }
    await expect(backups.restoreWorkspace({
      workspaceId: other.workspace.id,
      ownerUserId: other.user.id,
      packed: crossPacked,
      conflictPolicy: "reject",
    })).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await sql`SELECT id FROM library_documents WHERE workspace_id=${other.workspace.id}`).toEqual([]);

    const wipeNotesOnly = async () => {
      await sql`TRUNCATE library_documents RESTART IDENTITY CASCADE`;
    };

    await wipeNotesOnly();
    const restored = await backups.restoreWorkspace({
      ...scope,
      packed,
      conflictPolicy: "reject",
    });
    expect(restored.applied.documents).toBe(1);
    expect((await sql`SELECT context_source_refs FROM opening_note_provenance WHERE document_id=${documentId}`)[0]!.context_source_refs)
      .toEqual(expectedDbProvenance);

    const collectedMemoryIds = new Set<string>();
    const collectedOriginTurnIds = new Set<string>();
    const readSystemQuery = createScopedOpeningSystemQueryReader(sql, scope, {
      collectLineage: lineage => {
        for (const id of lineage.memoryIds) collectedMemoryIds.add(id);
        for (const id of lineage.originTurnIds) collectedOriginTurnIds.add(id);
      },
    });
    const queryResult = await readSystemQuery(
      { name: "notes", arguments: { offset: 0, limit: 10 } },
      new AbortController().signal,
    );
    expect(queryResult.status).toBe("ok");
    expect(queryResult.data).toMatchObject([{ id: documentId, title: "Memory-backed snippet" }]);
    expect([...collectedMemoryIds]).toEqual([memoryId]);
    expect([...collectedOriginTurnIds].sort()).toEqual(expectedOriginTurnIds);

    const skipped = await backups.restoreWorkspace({
      ...scope,
      packed,
      conflictPolicy: "skip",
    });
    expect(skipped.skipped.documents).toBe(1);
    expect((await sql`SELECT context_source_refs FROM opening_note_provenance WHERE document_id=${documentId}`)[0]!.context_source_refs)
      .toEqual(expectedDbProvenance);

    const stripped = structuredClone(packed);
    (stripped.records.documents[0] as Record<string, unknown>).openingProvenance = null;
    await expect(backups.restoreWorkspace({
      ...scope,
      packed: stripped,
      conflictPolicy: "skip",
    })).rejects.toMatchObject({ code: "VALIDATION" });

    // Deleting/revoking the referenced memory withholds export and fails closed on restore.
    await sql`UPDATE opening_memories SET status='deleted' WHERE id=${memoryId}`;
    const afterMemoryDeleted = await backups.exportWorkspace(scope);
    expect(afterMemoryDeleted.records.documents).toEqual([]);
    expect(JSON.stringify(afterMemoryDeleted)).not.toContain("PRIVATE-SNIPPET-BODY");
    expect((await readSystemQuery({ name: "notes", arguments: { offset: 0, limit: 10 } }, new AbortController().signal)).data)
      .toEqual([]);

    const revisionOnlyPacked = structuredClone(packed);
    revisionOnlyPacked.records.documents = [];
    revisionOnlyPacked.records.blocks = [];
    (revisionOnlyPacked.records.revisions[0] as Record<string, unknown>).id = randomUUID();
    await expect(backups.restoreWorkspace({
      ...scope,
      packed: revisionOnlyPacked,
      conflictPolicy: "skip",
    })).rejects.toMatchObject({ code: "VALIDATION" });

    await wipeNotesOnly();
    await expect(backups.restoreWorkspace({
      ...scope,
      packed,
      conflictPolicy: "reject",
    })).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await sql`SELECT id FROM library_documents WHERE workspace_id=${scope.workspaceId}`).toEqual([]);

    // Restore memory, verify restore succeeds again, then make origin turn unavailable and verify export/restore fail closed.
    await sql`UPDATE opening_memories SET status='active' WHERE id=${memoryId}`;
    await backups.restoreWorkspace({ ...scope, packed, conflictPolicy: "reject" });
    await sql`DELETE FROM opening_conversations WHERE id=${conversationId}`;
    const afterTurnDeleted = await backups.exportWorkspace(scope);
    expect(afterTurnDeleted.records.documents).toEqual([]);
    expect(JSON.stringify(afterTurnDeleted)).not.toContain("PRIVATE-SNIPPET-BODY");
    await wipeNotesOnly();
    await expect(backups.restoreWorkspace({
      ...scope,
      packed,
      conflictPolicy: "reject",
    })).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await sql`SELECT id FROM library_documents WHERE workspace_id=${scope.workspaceId}`).toEqual([]);
  });

  it.each(["spec-unit", "item-revision"] as const)(
    "fails closed when restoring foreign or restricted child records onto a retained automatic card (%s)",
    async linkKind => {
      const target = await identity.createUserWithWorkspace({
        email: `auto-target-${linkKind}-${randomUUID()}@example.com`,
        displayName: "Target",
        passwordHash: "unused",
      });
      const foreign = await identity.createUserWithWorkspace({
        email: `auto-foreign-${linkKind}-${randomUUID()}@example.com`,
        displayName: "Foreign",
        passwordHash: "unused",
      });
      const targetScope = { workspaceId: target.workspace.id, ownerUserId: target.user.id };
      const foreignBase = await backups.exportWorkspace({ workspaceId: foreign.workspace.id, ownerUserId: foreign.user.id });
      const sameBase = await backups.exportWorkspace(targetScope);

      const course = await courses.createCourse({
        workspaceId: targetScope.workspaceId,
        title: "Auto Card Course",
        slug: `auto-${randomUUID()}`,
      });
      const plainDoc = await library.createDocument({
        workspaceId: targetScope.workspaceId,
        title: "Plain Reference",
        lifecycle: "scratch",
        blocks: [{ id: randomUUID(), type: "paragraph", content: { text: "Plain body" } }],
      });
      const teachingBlockId = randomUUID();
      const teachingDoc = await library.createDocument({
        workspaceId: targetScope.workspaceId,
        title: "Teaching Lesson",
        lifecycle: "scratch",
        blocks: [{ id: teachingBlockId, type: "paragraph", content: { text: "Teaching lesson body" } }],
      });
      const [teachingRev] = await sql<{ id: string }[]>`SELECT id FROM library_revisions
        WHERE document_id=${teachingDoc.id} AND workspace_id=${targetScope.workspaceId} AND revision_number=1`;

      const sourceId = randomUUID();
      await sql`INSERT INTO opening_sources(id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state)
        VALUES(${sourceId},${targetScope.workspaceId},'teaching.txt','text/plain',1,${"d".repeat(64)},1,'uploaded','ready')`;

      const activityId = randomUUID();
      const sessionId = randomUUID();
      const observationId = randomUUID();
      await sql`INSERT INTO opening_teaching_activities(id,workspace_id,owner_user_id,course_id,status,intent_kind,intent_summary,source_ids,client_key,create_intent)
        VALUES(${activityId},${targetScope.workspaceId},${targetScope.ownerUserId},${course.id},'active','course_continue','Auto card lesson','{}'::uuid[],${`act-${activityId}`},'{}'::jsonb)`;
      await sql`INSERT INTO opening_learning_sessions(id,workspace_id,owner_user_id,course_id,activity_id,skill_label,source_ids)
        VALUES(${sessionId},${targetScope.workspaceId},${targetScope.ownerUserId},${course.id},${activityId},'Derivatives','{}'::uuid[])`;
      await sql`INSERT INTO opening_workspace_history_revisions(workspace_id,owner_user_id,revision)
        VALUES(${targetScope.workspaceId},${targetScope.ownerUserId},0) ON CONFLICT DO NOTHING`;

      let itemVersionId: string | null = null;
      if (linkKind === "spec-unit") {
        const unitId = randomUUID();
        await sql`INSERT INTO opening_teaching_units(id,workspace_id,owner_user_id,title,document_id,current_revision_number)
          VALUES(${unitId},${targetScope.workspaceId},${targetScope.ownerUserId},'Teaching Lesson',${teachingDoc.id},1)`;
        await sql`INSERT INTO opening_teaching_activity_specs(id,workspace_id,owner_user_id,activity_id,teaching_unit_id,document_id,revision_number,source_refs,version)
          VALUES(${randomUUID()},${targetScope.workspaceId},${targetScope.ownerUserId},${activityId},${unitId},${teachingDoc.id},1,${sql.json([{ sourceId, version: 1 }])},1)`;
      } else {
        itemVersionId = randomUUID();
        await sql`INSERT INTO opening_learning_item_versions(id,workspace_id,owner_user_id,course_id,activity_id,problem_id,stem_snapshot,artifact_kind,teaching_revision_id,teaching_block_id)
          VALUES(${itemVersionId},${targetScope.workspaceId},${targetScope.ownerUserId},${course.id},${activityId},${randomUUID()},'Classroom question','reference_item',${teachingRev!.id},${teachingBlockId})`;
        await sql`INSERT INTO opening_note_provenance(document_id,workspace_id,context_source_refs)
          VALUES(${teachingDoc.id},${targetScope.workspaceId},${sql.json([{ sourceId, sourceVersion: 1, publication: true }])})`;
      }

      await sql`INSERT INTO opening_learning_observations(
          id,workspace_id,owner_user_id,session_id,course_id,activity_id,item_version_id,skill_label,source_ids,
          answer,outcome,assistance,client_key,source_turn_ids,verdict_source,workspace_history_revision,root_observation_id,effective_head_id
        ) VALUES(
          ${observationId},${targetScope.workspaceId},${targetScope.ownerUserId},${sessionId},${course.id},${activityId},${itemVersionId},
          'Derivatives','{}'::uuid[],'Wrong answer','unverified','unknown',${`obs-${observationId}`},'{}'::uuid[],'unknown',0,${observationId},${observationId}
        )`;

      const autoCardId = randomUUID();
      await sql`INSERT INTO cards(id,workspace_id,owner_user_id,front,back,source_document_id,source_ids,origin_observation_root_id)
        VALUES(${autoCardId},${targetScope.workspaceId},${targetScope.ownerUserId},'Auto question','Auto answer',NULL,'{}'::uuid[],${observationId})`;

      const makeChildPayloads = (ownerId: string): Array<Record<string, unknown[]>> => [
        {
          events: [{
            id: randomUUID(),
            ownerUserId: ownerId,
            type: "review",
            schemaVersion: 1,
            idempotencyKey: `forged-review-${randomUUID()}`,
            occurredAt: "2026-08-15T03:00:00.000Z",
            contentId: autoCardId,
            contentVersion: 1,
            payload: { grade: "good", assisted: false, excludeFromAssessment: false },
          }],
        },
        {
          memberships: [{
            id: randomUUID(),
            courseId: course.id,
            assetType: "card",
            assetId: autoCardId,
            role: "core",
            sortOrder: 0,
            visibility: "course",
          }],
        },
        {
          relations: [{
            id: randomUUID(),
            fromType: "document",
            fromId: plainDoc.id,
            toType: "card",
            toId: autoCardId,
            relationType: "references",
            source: { kind: "user" },
          }],
        },
      ];

      // 1. Foreign-workspace child payloads targeting the retained automatic card must fail closed.
      for (const mutation of makeChildPayloads(foreign.user.id)) {
        const packed = structuredClone(foreignBase);
        Object.assign(packed.records, mutation);
        await expect(backups.restoreWorkspace({
          ...targetScope,
          packed,
          conflictPolicy: "skip",
        })).rejects.toMatchObject({ code: "VALIDATION" });
      }
      expect(await sql`SELECT id FROM learning_events WHERE workspace_id=${targetScope.workspaceId}`).toEqual([]);
      expect(await sql`SELECT id FROM course_asset_memberships WHERE workspace_id=${targetScope.workspaceId}`).toEqual([]);
      expect(await sql`SELECT id FROM library_relations WHERE workspace_id=${targetScope.workspaceId}`).toEqual([]);

      // 2. Same-workspace child payloads fail closed once the backing teaching source is excluded.
      await sql`INSERT INTO opening_privacy_exclusions(workspace_id,source_id,deleted_at)
        VALUES(${targetScope.workspaceId},${sourceId},now())`;
      for (const mutation of makeChildPayloads(targetScope.ownerUserId)) {
        const packed = structuredClone(sameBase);
        Object.assign(packed.records, mutation);
        await expect(backups.restoreWorkspace({
          ...targetScope,
          packed,
          conflictPolicy: "skip",
        })).rejects.toMatchObject({ code: "VALIDATION" });
      }
      expect(await sql`SELECT id FROM learning_events WHERE workspace_id=${targetScope.workspaceId}`).toEqual([]);
    },
  );

  it("fails closed when a candidate card's only publicationCardIds link is in a foreign workspace or soft-deleted document", async () => {
    const owner = await identity.createUserWithWorkspace({
      email: `pub-owner-${randomUUID()}@example.com`,
      displayName: "Owner",
      passwordHash: "unused",
    });
    const foreign = await identity.createUserWithWorkspace({
      email: `pub-foreign-${randomUUID()}@example.com`,
      displayName: "Foreign",
      passwordHash: "unused",
    });
    const scope = { workspaceId: owner.workspace.id, ownerUserId: owner.user.id };
    const foreignScope = { workspaceId: foreign.workspace.id, ownerUserId: foreign.user.id };
    const basePacked = await backups.exportWorkspace(scope);

    const foreignDoc = await library.createDocument({
      workspaceId: foreignScope.workspaceId,
      title: "Foreign publication note",
      lifecycle: "scratch",
      blocks: [{ id: randomUUID(), type: "paragraph", content: { text: "Foreign body" } }],
    });
    const candidateCard = await cards.createCard({
      workspaceId: scope.workspaceId,
      ownerUserId: scope.ownerUserId,
      front: "Candidate card",
      back: "Candidate answer",
    });
    await sql`INSERT INTO opening_note_provenance(document_id,workspace_id,context_source_refs)
      VALUES(${foreignDoc.id},${foreignScope.workspaceId},${sql.json([{ publicationCardIds: [candidateCard.id] }])})`;

    // Confirm cardReadable withholds the card on live reads.
    await expect(cards.getCard({ workspaceId: scope.workspaceId, cardId: candidateCard.id }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });

    // Restore attempting to attach a review to candidateCard must also fail closed.
    const reviewPacked = structuredClone(basePacked);
    reviewPacked.records.events = [{
      id: randomUUID(),
      ownerUserId: scope.ownerUserId,
      type: "review",
      schemaVersion: 1,
      idempotencyKey: `pub-review-${randomUUID()}`,
      occurredAt: "2026-08-15T03:00:00.000Z",
      contentId: candidateCard.id,
      contentVersion: 1,
      payload: { grade: "good", assisted: false, excludeFromAssessment: false },
    }];
    await expect(backups.restoreWorkspace({
      ...scope,
      packed: reviewPacked,
      conflictPolicy: "skip",
    })).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await sql`SELECT id FROM learning_events WHERE workspace_id=${scope.workspaceId}`).toEqual([]);

    // Also fail closed when candidateCard is not in DB yet (new card restore) while foreign publicationCardIds exists.
    await sql`DELETE FROM cards WHERE id=${candidateCard.id}`;
    const newCardPacked = structuredClone(basePacked);
    newCardPacked.records.cards = [{
      id: candidateCard.id,
      ownerUserId: scope.ownerUserId,
      front: "Candidate card",
      back: "Candidate answer",
      sourceDocumentId: null,
      sourceIds: [],
      tags: [],
      archived: false,
      contentVersion: 1,
      autoPaused: false,
      excludeFromAssessment: false,
    }];
    await expect(backups.restoreWorkspace({
      ...scope,
      packed: newCardPacked,
      conflictPolicy: "reject",
    })).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await sql`SELECT id FROM cards WHERE workspace_id=${scope.workspaceId}`).toEqual([]);

    // Same-workspace publicationCardIds pointing to a soft-deleted document must also fail closed.
    await sql`DELETE FROM opening_note_provenance WHERE document_id=${foreignDoc.id}`;
    const localDoc = await library.createDocument({
      workspaceId: scope.workspaceId,
      title: "Soft-deleted publication note",
      lifecycle: "scratch",
      blocks: [{ id: randomUUID(), type: "paragraph", content: { text: "Soft-deleted body" } }],
    });
    await sql`INSERT INTO opening_note_provenance(document_id,workspace_id,context_source_refs)
      VALUES(${localDoc.id},${scope.workspaceId},${sql.json([{ publicationCardIds: [candidateCard.id] }])})`;
    await sql`UPDATE library_documents SET deleted_at=now() WHERE id=${localDoc.id}`;
    await expect(backups.restoreWorkspace({
      ...scope,
      packed: newCardPacked,
      conflictPolicy: "skip",
    })).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await sql`SELECT id FROM cards WHERE workspace_id=${scope.workspaceId}`).toEqual([]);
  });

  it("fails closed under skip when an incoming correction attaches to a retained review or correction chain targeting a restricted card", async () => {
    const owner = await identity.createUserWithWorkspace({
      email: `corr-skip-${randomUUID()}@example.com`,
      displayName: "Correction Skip",
      passwordHash: "unused",
    });
    const scope = { workspaceId: owner.workspace.id, ownerUserId: owner.user.id };
    const basePacked = await backups.exportWorkspace(scope);

    const sourceId = randomUUID();
    await sql`INSERT INTO opening_sources(id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state)
      VALUES(${sourceId},${scope.workspaceId},'restricted.txt','text/plain',1,${"e".repeat(64)},1,'uploaded','ready')`;
    const restrictedCardId = randomUUID();
    const cleanCardId = randomUUID();
    await sql`INSERT INTO cards(id,workspace_id,owner_user_id,front,back,source_ids) VALUES
      (${restrictedCardId},${scope.workspaceId},${scope.ownerUserId},'Restricted front','Restricted back',${[sourceId]}),
      (${cleanCardId},${scope.workspaceId},${scope.ownerUserId},'Clean front','Clean back','{}'::uuid[])`;

    const storedReviewId = randomUUID();
    const storedCorrectionId = randomUUID();
    await sql`INSERT INTO learning_events(id,workspace_id,owner_user_id,type,schema_version,idempotency_key,occurred_at,content_id,content_version,payload)
      VALUES(${storedReviewId},${scope.workspaceId},${scope.ownerUserId},'review',1,${storedReviewId},now(),${restrictedCardId},1,'{"grade":"good"}')`;
    await sql`INSERT INTO opening_privacy_exclusions(workspace_id,source_id,deleted_at)
      VALUES(${scope.workspaceId},${sourceId},now())`;

    // Case 1: Colliding review pretending to target cleanCardId + new incoming correction (and 2nd-hop correction).
    const forgedDirect = structuredClone(basePacked);
    const hop1 = randomUUID();
    const hop2 = randomUUID();
    forgedDirect.records.events = [
      {
        id: storedReviewId,
        ownerUserId: scope.ownerUserId,
        type: "review",
        schemaVersion: 1,
        idempotencyKey: `forged-${storedReviewId}`,
        occurredAt: "2026-08-15T03:00:00.000Z",
        contentId: cleanCardId,
        contentVersion: 1,
        payload: { grade: "good" },
      },
      {
        id: hop1,
        ownerUserId: scope.ownerUserId,
        type: "correction",
        schemaVersion: 1,
        idempotencyKey: hop1,
        occurredAt: "2026-08-15T03:01:00.000Z",
        correctsEventId: storedReviewId,
        payload: { note: "Forged correction hop 1" },
      },
      {
        id: hop2,
        ownerUserId: scope.ownerUserId,
        type: "correction",
        schemaVersion: 1,
        idempotencyKey: hop2,
        occurredAt: "2026-08-15T03:02:00.000Z",
        correctsEventId: hop1,
        payload: { note: "Forged correction hop 2" },
      },
    ];
    await expect(backups.restoreWorkspace({
      ...scope,
      packed: forgedDirect,
      conflictPolicy: "skip",
    })).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await sql`SELECT id FROM learning_events WHERE workspace_id=${scope.workspaceId}`).toEqual([{ id: storedReviewId }]);

    // Case 2: Multi-hop stored chain (storedCorrectionId -> storedReviewId), incoming clean review + colliding correction + leaf correction.
    await sql`INSERT INTO learning_events(id,workspace_id,owner_user_id,type,schema_version,idempotency_key,occurred_at,corrects_event_id,payload)
      VALUES(${storedCorrectionId},${scope.workspaceId},${scope.ownerUserId},'correction',1,${storedCorrectionId},now(),${storedReviewId},'{"note":"Stored correction"}')`;
    const forgedMultiHop = structuredClone(basePacked);
    const cleanReviewId = randomUUID();
    const leafCorrectionId = randomUUID();
    forgedMultiHop.records.events = [
      {
        id: cleanReviewId,
        ownerUserId: scope.ownerUserId,
        type: "review",
        schemaVersion: 1,
        idempotencyKey: cleanReviewId,
        occurredAt: "2026-08-15T03:00:00.000Z",
        contentId: cleanCardId,
        contentVersion: 1,
        payload: { grade: "good" },
      },
      {
        id: storedCorrectionId,
        ownerUserId: scope.ownerUserId,
        type: "correction",
        schemaVersion: 1,
        idempotencyKey: `forged-${storedCorrectionId}`,
        occurredAt: "2026-08-15T03:01:00.000Z",
        correctsEventId: cleanReviewId,
        payload: { note: "Colliding middle correction" },
      },
      {
        id: leafCorrectionId,
        ownerUserId: scope.ownerUserId,
        type: "correction",
        schemaVersion: 1,
        idempotencyKey: leafCorrectionId,
        occurredAt: "2026-08-15T03:02:00.000Z",
        correctsEventId: storedCorrectionId,
        payload: { note: "Leaf correction attaching to restricted chain" },
      },
    ];
    await expect(backups.restoreWorkspace({
      ...scope,
      packed: forgedMultiHop,
      conflictPolicy: "skip",
    })).rejects.toMatchObject({ code: "VALIDATION" });
    expect((await sql`SELECT id FROM learning_events WHERE workspace_id=${scope.workspaceId}`).map(row => row.id).sort())
      .toEqual([storedReviewId, storedCorrectionId].sort());
  });

  it("restores valid same-workspace linked notes and automatic cards when archive UUIDs are uppercase", async () => {
    const owner = await identity.createUserWithWorkspace({
      email: `upper-uuid-${randomUUID()}@example.com`,
      displayName: "Uppercase UUID",
      passwordHash: "unused",
    });
    const scope = { workspaceId: owner.workspace.id, ownerUserId: owner.user.id };

    const sourceId = randomUUID();
    const convId = randomUUID();
    const turnId = randomUUID();
    await sql`INSERT INTO opening_sources(id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state)
      VALUES(${sourceId},${scope.workspaceId},'upper.txt','text/plain',1,${"f".repeat(64)},1,'uploaded','ready')`;
    await sql`INSERT INTO opening_conversations(id,workspace_id,owner_user_id,title)
      VALUES(${convId},${scope.workspaceId},${scope.ownerUserId},'Upper dialogue')`;
    await sql`INSERT INTO opening_turns(id,workspace_id,conversation_id,role,text,mode,status,context_source_refs)
      VALUES(${turnId},${scope.workspaceId},${convId},'assistant','Upper answer','listen','complete',${sql.json([{ sourceId, sourceVersion: 1 }])})`;

    const notes = createOpeningNoteRepository(sql);
    const { documentId: snippetDocId } = await notes.saveSnippet(scope, {
      title: "Uppercase linked note",
      text: "Uppercase linked note body",
      savedTurnId: turnId,
    });

    const course = await courses.createCourse({
      workspaceId: scope.workspaceId,
      title: "Upper Course",
      slug: `upper-${randomUUID()}`,
    });
    const activityId = randomUUID();
    const sessionId = randomUUID();
    const observationId = randomUUID();
    const unitId = randomUUID();
    const teachingDoc = await library.createDocument({
      workspaceId: scope.workspaceId,
      title: "Upper Teaching Unit",
      lifecycle: "scratch",
      blocks: [{ id: randomUUID(), type: "paragraph", content: { text: "Upper teaching body" } }],
    });
    await sql`INSERT INTO opening_teaching_activities(id,workspace_id,owner_user_id,course_id,status,intent_kind,intent_summary,source_ids,client_key,create_intent)
      VALUES(${activityId},${scope.workspaceId},${scope.ownerUserId},${course.id},'active','course_continue','Upper lesson',${[sourceId]},${`act-${activityId}`},'{}'::jsonb)`;
    await sql`INSERT INTO opening_teaching_units(id,workspace_id,owner_user_id,title,document_id,current_revision_number)
      VALUES(${unitId},${scope.workspaceId},${scope.ownerUserId},'Upper Teaching Unit',${teachingDoc.id},1)`;
    await sql`INSERT INTO opening_teaching_activity_specs(id,workspace_id,owner_user_id,activity_id,teaching_unit_id,document_id,revision_number,source_refs,version)
      VALUES(${randomUUID()},${scope.workspaceId},${scope.ownerUserId},${activityId},${unitId},${teachingDoc.id},1,${sql.json([{ sourceId, version: 1 }])},1)`;
    await sql`INSERT INTO opening_learning_sessions(id,workspace_id,owner_user_id,course_id,activity_id,skill_label,source_ids)
      VALUES(${sessionId},${scope.workspaceId},${scope.ownerUserId},${course.id},${activityId},'Limits',${[sourceId]})`;
    await sql`INSERT INTO opening_workspace_history_revisions(workspace_id,owner_user_id,revision)
      VALUES(${scope.workspaceId},${scope.ownerUserId},0) ON CONFLICT DO NOTHING`;
    await sql`INSERT INTO opening_learning_observations(
        id,workspace_id,owner_user_id,session_id,course_id,activity_id,skill_label,source_ids,
        answer,outcome,assistance,client_key,source_turn_ids,verdict_source,workspace_history_revision,root_observation_id,effective_head_id
      ) VALUES(
        ${observationId},${scope.workspaceId},${scope.ownerUserId},${sessionId},${course.id},${activityId},
        'Limits',${[sourceId]},'Wrong','unverified','unknown',${`obs-${observationId}`},'{}'::uuid[],'unknown',0,${observationId},${observationId}
      )`;

    const autoCardId = randomUUID();
    await sql`INSERT INTO cards(id,workspace_id,owner_user_id,course_id,front,back,source_document_id,source_ids,origin_observation_root_id)
      VALUES(${autoCardId},${scope.workspaceId},${scope.ownerUserId},${course.id},'Upper auto front','Upper auto back',${snippetDocId},${[sourceId]},${observationId})`;
    const reviewEvent = await events.append({
      workspaceId: scope.workspaceId,
      ownerUserId: scope.ownerUserId,
      type: "review",
      idempotencyKey: `upper-review-${randomUUID()}`,
      occurredAt: "2026-08-15T03:00:00.000Z",
      contentId: autoCardId,
      contentVersion: 1,
      payload: { grade: "good", assisted: false, excludeFromAssessment: false },
    });
    const correctionEvent = await events.append({
      workspaceId: scope.workspaceId,
      ownerUserId: scope.ownerUserId,
      type: "correction",
      idempotencyKey: `upper-corr-${randomUUID()}`,
      occurredAt: "2026-08-15T03:01:00.000Z",
      correctsEventId: reviewEvent.id,
      payload: { kind: "content_flag", note: "Upper correction" },
    });

    const exported = await backups.exportWorkspace(scope);
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const uppercaseUuids = (value: unknown): unknown => {
      if (typeof value === "string") return uuidPattern.test(value) ? value.toUpperCase() : value;
      if (Array.isArray(value)) return value.map(uppercaseUuids);
      if (!value || typeof value !== "object") return value;
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [
          k,
          k === "sha256" || k === "idempotencyKey" ? v : uppercaseUuids(v),
        ]),
      );
    };
    const upperPacked = uppercaseUuids(exported) as typeof exported;
    expect(upperPacked.sourceWorkspaceId).toBe(scope.workspaceId.toUpperCase());

    // 1. Same-workspace skip restore onto retained lowercase DB entities succeeds with uppercase archive UUIDs.
    const skipResult = await backups.restoreWorkspace({
      workspaceId: scope.workspaceId,
      ownerUserId: scope.ownerUserId,
      packed: upperPacked,
      conflictPolicy: "skip",
    });
    expect(skipResult.skipped).toMatchObject({ documents: 2, cards: 1, events: 2 });
    expect(skipResult.applied).toMatchObject({ documents: 0, cards: 0, events: 0 });

    // 2. Delete native records (without TRUNCATE CASCADE into Opening turns/observations), then full reject restore succeeds.
    await sql`DELETE FROM opening_teaching_activity_specs WHERE workspace_id=${scope.workspaceId}`;
    await sql`DELETE FROM opening_teaching_units WHERE workspace_id=${scope.workspaceId}`;
    await sql`TRUNCATE learning_events, card_review_states, cards, library_documents RESTART IDENTITY CASCADE`;
    await sql`DELETE FROM courses WHERE workspace_id=${scope.workspaceId}`;
    const rejectResult = await backups.restoreWorkspace({
      workspaceId: scope.workspaceId,
      ownerUserId: scope.ownerUserId,
      packed: upperPacked,
      conflictPolicy: "reject",
    });
    expect(rejectResult.applied).toMatchObject({ courses: 1, documents: 2, cards: 1, events: 2 });
    expect((await cards.getCard({ workspaceId: scope.workspaceId, cardId: autoCardId })).id).toBe(autoCardId);
    expect((await events.get({ workspaceId: scope.workspaceId, eventId: correctionEvent.id })).id).toBe(correctionEvent.id);
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
