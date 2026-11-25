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

    await sql`INSERT INTO opening_note_provenance(document_id,workspace_id,context_source_refs)
      VALUES(${badNote.id},${scope.workspaceId},${sql.json([
        { sourceId, sourceVersion: 1, legacy: [] },
        { publicationCardIds: [pubCard.id] },
      ])})`;

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

    await wipeLearningData();
    for (const badRefs of [
      [{ sourceId, sourceVersion: 1, legacy: [] }],
      [{ sourceId, sourceVersion: 1, publication: false }],
    ]) {
      const forged = structuredClone(nativePacked);
      (forged.records.documents[0] as Record<string, unknown>).openingProvenance = { contextSourceRefs: badRefs };
      await expect(backups.restoreWorkspace({ ...scope, packed: forged, conflictPolicy: "reject" }))
        .rejects.toMatchObject({ code: "VALIDATION" });
    }
  });

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
