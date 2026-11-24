import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createScopedOpeningSystemQueryReader } from "../../packages/database/src/repositories/opening-system-query";
import { createOpeningDatasetRepository } from "../../packages/database/src/repositories/opening-dataset";
import { OPENING_DATASET_POLICY_VERSION } from "@aistudy/contracts";
import { createCardRepository, createCourseMembershipRepository, createLibraryRepository, createOpeningBudgetRepository,
  createOpeningEphemeralProvenanceRepository, createOpeningPrivacyRepository, createOpeningMemoryRepository,
  createOpeningNoteRepository } from "@aistudy/database";
import { createEphemeralTutorService } from "../../apps/web/src/features/opening/tutor/ephemeral-service";
import { replyEphemeralSystemQuery } from "../../apps/web/src/features/opening/tutor/ephemeral-system-query";
import { createDbSystemQueryService } from "../../apps/worker/src/runtime/system-query";
import { createOpeningFixture, insertTestTeachingActivity, type OpeningFixture } from "./opening-fixture";
import { insertMemory, insertOwnedTurn, insertSource } from "./opening-memory-context-fixture";
import { backupRows } from "./opening-backup-records-fixture";

let f: OpeningFixture;
let repo: ReturnType<typeof createOpeningDatasetRepository>;
const grant = () => repo.grantConsent(f.scope, { policyVersion: OPENING_DATASET_POLICY_VERSION, consented: true, expiresAt: new Date(Date.now() + 3600000).toISOString() });
beforeAll(async () => { f = await createOpeningFixture(); repo = createOpeningDatasetRepository(f.sql); });
afterAll(async () => { await f?.close(); });

describe("synthetic deidentified dataset repository", () => {
  it("gates all three views on explicit versioned, unexpired, unrevoked epoch consent", async () => {
    await expect(repo.read(f.scope)).rejects.toThrow(/consent/);
    await expect(repo.grantConsent(f.scope, { policyVersion: "wrong", consented: true, expiresAt: new Date(Date.now() + 3600000).toISOString() } as never)).rejects.toThrow(/consent/);
    const id = await grant();
    await expect(repo.read({ ...f.scope, ownerUserId: f.otherScope.ownerUserId })).rejects.toThrow();
    await expect(repo.revokeConsent(f.otherScope, id)).rejects.toThrow();
    await repo.revokeConsent(f.scope, id);
    await expect(repo.read(f.scope)).rejects.toThrow(/consent/);
    const newer = await grant();
    await f.sql`UPDATE opening_dataset_consents SET expires_at=now()-interval '1 second', granted_at=now()-interval '1 hour' WHERE id=${newer}`;
    await expect(repo.read(f.scope)).rejects.toThrow(/consent/);
    await grant();
    await f.sql`UPDATE workspaces SET privacy_epoch=privacy_epoch+1 WHERE id=${f.scope.workspaceId}`;
    await expect(repo.read(f.scope)).rejects.toThrow(/consent/);
  });

  it("joins within an export, rotates identities, excludes deleted source and memory lineage", async () => {
    const source = randomUUID(), conversation = randomUUID(), turn = randomUUID();
    await f.sql`INSERT INTO opening_sources(id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state)
      VALUES(${source},${f.scope.workspaceId},'private@example.com','application/pdf',1,${'a'.repeat(64)},0,'uploaded','ready')`;
    const activity = await insertTestTeachingActivity(f.sql, f.scope);
    await f.sql`UPDATE opening_teaching_activities SET source_ids=${[source]}::uuid[],generate_status='ready' WHERE id=${activity}`;
    await f.sql`INSERT INTO opening_conversations(id,workspace_id,owner_user_id,title) VALUES(${conversation},${f.scope.workspaceId},${f.scope.ownerUserId},'secret')`;
    await f.sql`INSERT INTO opening_turns(id,workspace_id,conversation_id,role,text,mode,status,source_ids,source_versions)
      VALUES(${turn},${f.scope.workspaceId},${conversation},'user','private@example.com','explain','complete',${[source]}::uuid[],${f.sql.json({[source]:0})})`;
    const session = randomUUID(), attempt = randomUUID();
    await f.sql`INSERT INTO opening_learning_sessions(id,workspace_id,owner_user_id,activity_id,skill_label,source_ids) VALUES(${session},${f.scope.workspaceId},${f.scope.ownerUserId},${activity},'secret',${[source]}::uuid[])`;
    await f.sql`INSERT INTO opening_learning_attempts(id,workspace_id,owner_user_id,session_id,activity_id,skill_label,source_ids,source_versions,client_key,create_intent,history_revision)
      VALUES(${attempt},${f.scope.workspaceId},${f.scope.ownerUserId},${session},${activity},'secret',${[source]}::uuid[],${f.sql.json({[source]:0})},${randomUUID()},'{}',0)`;
    await grant();
    const a = await repo.read(f.scope), b = await repo.read(f.scope);
    expect(a.dialogueEvaluation).toHaveLength(1);
    expect(a.answerSequences).toHaveLength(1);
    expect(a.coursePackageQuality).toHaveLength(1);
    expect(a.answerSequences[0].sequence).toBe(a.coursePackageQuality[0].identity);
    expect(a.dialogueEvaluation[0].sources).toEqual(a.coursePackageQuality[0].sources);
    expect(a.dialogueEvaluation[0].identity).not.toBe(b.dialogueEvaluation[0].identity);
    for (const secret of [source,turn,attempt,activity,conversation,f.scope.workspaceId,f.scope.ownerUserId,'private@example.com','secret']) expect(JSON.stringify(a)).not.toContain(secret);
    const privacy = createOpeningPrivacyRepository(f.sql);
    await privacy.recordExclusions(f.sql,f.scope,{ sourceIds:[source],memoryId:randomUUID(),deletedAt:new Date() });
    await expect(repo.read(f.scope)).rejects.toThrow(/consent/);
    await grant();
    const after = await repo.read(f.scope);
    expect(after.dialogueEvaluation).toEqual([]);
    expect(after.answerSequences).toEqual([]);
    expect(after.coursePackageQuality).toEqual([]);
    const bare = randomUUID();
    await f.sql`INSERT INTO opening_turns(id,workspace_id,conversation_id,role,text,mode,status,source_ids,source_versions)
      VALUES(${bare},${f.scope.workspaceId},${conversation},'user','memory-private','explain','complete','{}','{}')`;
    const memories = createOpeningMemoryRepository(f.sql);
    const memory = await memories.proposeMemory(f.scope,{text:'memory-private',sourceTurnIds:[bare],expiresAt:null});
    await memories.deleteMemory(f.scope,{id:memory.id,expectedVersion:memory.version,deleteSourceText:false,clientKey:randomUUID()});
    await expect(repo.read(f.scope)).rejects.toThrow(/consent/);
    await grant();
    expect((await repo.read(f.scope)).dialogueEvaluation).toEqual([]);
    await grantOther();
    expect((await repo.read(f.otherScope)).dialogueEvaluation).toEqual([]);
  });

  it.each(["saved", "ephemeral"] as const)(
    "keeps the source turn and retires a republished %s snippet once its memory expires",
    async kind => {
      const fixture = await createOpeningFixture();
      try {
        const { sql, scope } = fixture;
        const datasets = createOpeningDatasetRepository(sql);
        const notes = createOpeningNoteRepository(sql);
        const sourceTurnId = await insertOwnedTurn(sql, scope);
        const memory = await createOpeningMemoryRepository(sql).proposeMemory(scope, {
          text: "Source-free preference", sourceTurnIds: [sourceTurnId],
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        });
        const memoryRefs = [{ memoryDependencyIds: [memory.id] }];
        const snippet = { title: "Derived snippet", text: "Derived answer" };
        const provenance = createOpeningEphemeralProvenanceRepository(sql);
        let initialReceipt: string | undefined;
        let documentId: string;
        if (kind === "saved") {
          const savedTurnId = await insertOwnedTurn(sql, scope, { role: "assistant", contextSourceRefs: memoryRefs });
          ({ documentId } = await notes.saveSnippet(scope, { ...snippet, savedTurnId }));
        } else {
          initialReceipt = await provenance.recordQuery!(scope, { requestId: randomUUID(), privacyEpoch: 0, contextSourceRefs: memoryRefs });
          const privacy = createOpeningPrivacyRepository(sql);
          const budget = createOpeningBudgetRepository(sql, { envCapCents: 10_000 });
          const service = createEphemeralTutorService({
            sources: { listOwnedIds: async () => [] }, chunks: { listForSources: async () => [] },
            privacy: { currentEpoch: privacy.getWorkspaceEpoch, snapshot: async current => ({
              epoch: await privacy.getWorkspaceEpoch(current), excludedSourceIds: await privacy.listExcludedSourceIds(current),
            }) },
            budget: {
              reserve: entry => budget.reserve(scope, entry),
              release: (requestId, reason) => budget.release(scope, requestId, reason),
              claimExecution: reservationId => budget.claimExecution(scope, reservationId),
              settle: (...args) => budget.settle(scope, ...args),
              markUnknown: reservationId => budget.markUnknown(scope, reservationId),
            },
            provenance,
            provider: { complete: async input => ({
              text: input.history[0]?.text ?? "History absent", citedChunkIds: [],
              requestId: null, inputTokens: 1, outputTokens: 1, candidates: [],
            }) },
            config: { maxContextCharacters: 200, reservedCents: 5, maxOutputTokens: 64,
              inputCentsPerMillion: 1, outputCentsPerMillion: 1 },
          });
          const reply = await service.replyEphemeral(scope, { text: "Follow up", mode: "listen", sourceIds: [], historyPrivacyEpoch: 0,
            history: [{ role: "assistant", text: snippet.text, provenanceId: initialReceipt }] });
          expect(reply).toMatchObject({ text: snippet.text, historyDiscarded: false, provenanceId: expect.any(String) });
          ({ documentId } = await notes.saveSnippet(scope, { ...snippet, provenanceId: reply.provenanceId! }));
          expect(await sql`SELECT context_source_refs FROM opening_note_provenance WHERE document_id=${documentId}`)
            .toEqual([{ context_source_refs: [...memoryRefs, { snippetLineageVersion: 1 }] }]);
        }
        await publishSnippet(fixture, documentId);
        await datasets.grantConsent(scope, { policyVersion: OPENING_DATASET_POLICY_VERSION, consented: true,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
        const before = await datasets.read(scope);
        expect(before.coursePackageQuality).toHaveLength(1);
        expect(before.answerSequences).toHaveLength(1);
        expect(before.dialogueEvaluation).toHaveLength(kind === "saved" ? 3 : 2);

        await sql`UPDATE opening_memories SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${memory.id}`;
        const after = await datasets.read(scope);
        expect(after.coursePackageQuality).toEqual([]);
        expect(after.answerSequences).toEqual([]);
        expect(after.dialogueEvaluation.map(row => row.role)).toEqual(["user"]);
        await expect(createLibraryRepository(sql).getDocument({ workspaceId: scope.workspaceId, documentId }))
          .resolves.toMatchObject({ id: documentId });
        if (initialReceipt) await expect(provenance.resolveHistory(scope, [{ provenanceId: initialReceipt }], 0)).resolves.toBeNull();
      } finally {
        await fixture.close();
      }
    }, 30_000,
  );

  it.each(["empty legacy", "missing restored"])("keeps a %s snippet readable while excluding it from republished exports", async kind => {
    const fixture = await createOpeningFixture();
    try {
      const { sql, scope } = fixture;
      const datasets = createOpeningDatasetRepository(sql);
      const savedTurnId = await insertOwnedTurn(sql, scope, { role: "assistant", contextSourceRefs: [] });
      const { documentId } = await createOpeningNoteRepository(sql).saveSnippet(scope, {
        title: "Old snippet", text: "Old answer", savedTurnId,
      });
      if (kind === "missing restored") {
        // NativeBackup can retain the first revision while omitting its Opening provenance.
        await sql`DELETE FROM opening_note_provenance WHERE document_id=${documentId}`;
      } else {
        await sql`UPDATE opening_note_provenance SET context_source_refs='[]'::jsonb WHERE document_id=${documentId}`;
      }
      await publishSnippet(fixture, documentId);
      await datasets.grantConsent(scope, { policyVersion: OPENING_DATASET_POLICY_VERSION, consented: true,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
      const dataset = await datasets.read(scope);
      expect(dataset.coursePackageQuality).toEqual([]);
      expect(dataset.answerSequences).toEqual([]);
      expect(dataset.dialogueEvaluation.map(row => row.role)).toEqual(["assistant"]);
      await expect(createLibraryRepository(sql).getDocument({ workspaceId: scope.workspaceId, documentId }))
        .resolves.toMatchObject({ id: documentId });
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it("withholds variants of restored, historically published, and deleted cards from both dataset views", async () => {
    const fixture = await createOpeningFixture();
    try {
      const { sql, scope } = fixture;
      const datasets = createOpeningDatasetRepository(sql);
      const notes = createOpeningNoteRepository(sql);
      const cards = createCardRepository(sql);
      const savedTurnId = await insertOwnedTurn(sql, scope, { role: "assistant", contextSourceRefs: [] });
      const restored = await notes.saveSnippet(scope, { title: "Restored snippet", text: "Answer", savedTurnId });
      const historical = await notes.saveSnippet(scope, { title: "Historical snippet", text: "Answer", savedTurnId });
      const directCard = await cards.createCard({ ...scope, sourceDocumentId: restored.documentId, front: "Prompt", back: "Answer" });
      const historicalCard = await cards.createCard({ ...scope, sourceDocumentId: historical.documentId, front: "Prompt", back: "Answer" });
      const deletedCard = await cards.createCard({ ...scope, front: "Prompt", back: "Answer" });
      const sourceId = await insertSource(sql, scope);
      const cleanCard = await cards.createCard({ ...scope, front: "Prompt", back: "Answer" });
      await sql`UPDATE cards SET source_ids=${[sourceId]}::uuid[] WHERE id=${cleanCard.id}`;

      for (const card of [directCard, historicalCard, deletedCard, cleanCard]) {
        const activity = await insertTestTeachingActivity(sql, scope);
        const session = randomUUID();
        await sql`UPDATE opening_teaching_activities SET intent_kind='question', generate_status='ready',
          create_intent=${sql.json({ kind: "card_review_variant", cardId: card.id })},
          source_ids=${card === cleanCard ? [sourceId] : []}::uuid[] WHERE id=${activity}`;
        await sql`INSERT INTO opening_learning_sessions(id,workspace_id,owner_user_id,activity_id,skill_label)
          VALUES(${session},${scope.workspaceId},${scope.ownerUserId},${activity},'Variant')`;
        await sql`INSERT INTO opening_learning_attempts(id,workspace_id,owner_user_id,session_id,activity_id,skill_label,client_key,create_intent,history_revision)
          VALUES(${randomUUID()},${scope.workspaceId},${scope.ownerUserId},${session},${activity},'Variant',${randomUUID()},'{}',0)`;
      }
      await datasets.grantConsent(scope, { policyVersion: OPENING_DATASET_POLICY_VERSION, consented: true,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
      const before = await datasets.read(scope);
      expect(before.coursePackageQuality).toHaveLength(4);
      expect(before.answerSequences).toHaveLength(4);

      await sql`DELETE FROM opening_note_provenance WHERE document_id=${restored.documentId}`;
      await sql`UPDATE opening_note_provenance SET context_source_refs=${sql.json([{ publicationCardIds: [historicalCard.id] }])}
        WHERE document_id=${historical.documentId}`;
      await sql`UPDATE cards SET source_document_id=NULL WHERE id=${historicalCard.id}`;
      await sql`DELETE FROM cards WHERE id=${deletedCard.id}`;

      const after = await datasets.read(scope);
      expect(after.coursePackageQuality).toHaveLength(1);
      expect(after.coursePackageQuality[0]?.sources).toEqual([expect.any(String)]);
      expect(after.answerSequences).toEqual([expect.objectContaining({ sequence: after.coursePackageQuality[0]?.identity })]);
    } finally { await fixture.close(); }
  }, 30_000);

  it("withholds a source-backed legacy snippet whose original memory expired", async () => {
    const fixture = await createOpeningFixture();
    try {
      const { sql, scope } = fixture;
      const source = { sourceId: await insertSource(sql, scope), sourceVersion: 0 };
      const { id: memoryId } = await createOpeningMemoryRepository(sql).proposeMemory(scope, {
        text: "Source-free memory", sourceTurnIds: [await insertOwnedTurn(sql, scope)],
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
      const savedTurnId = await insertOwnedTurn(sql, scope, { role: "assistant",
        contextSourceRefs: [source, { memoryDependencyIds: [memoryId] }] });
      const { documentId } = await createOpeningNoteRepository(sql).saveSnippet(scope, {
        title: "Mixed provenance", text: "Old answer", savedTurnId,
      });
      await sql`UPDATE opening_note_provenance SET context_source_refs=${sql.json([source])} WHERE document_id=${documentId}`;
      await publishSnippet(fixture, documentId);
      await sql`UPDATE opening_memories SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${memoryId}`;
      const datasets = createOpeningDatasetRepository(sql);
      await datasets.grantConsent(scope, { policyVersion: OPENING_DATASET_POLICY_VERSION, consented: true,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
      const dataset = await datasets.read(scope);
      expect(dataset.coursePackageQuality).toEqual([]);
      expect(dataset.answerSequences).toEqual([]);
      expect(dataset.dialogueEvaluation.map(row => row.role)).toEqual(["user"]);
      await expect(createLibraryRepository(sql).getDocument({ workspaceId: scope.workspaceId, documentId }))
        .resolves.toMatchObject({ id: documentId });
    } finally { await fixture.close(); }
  });

  it("withholds a snippet republished after its saved origin is deleted", async () => {
    const fixture = await createOpeningFixture();
    try {
      const { sql, scope } = fixture;
      const savedTurnId = await insertOwnedTurn(sql, scope, { role: "assistant", contextSourceRefs: [] });
      const memories = createOpeningMemoryRepository(sql);
      const memory = await memories.proposeMemory(scope, { text: "Origin", sourceTurnIds: [savedTurnId], expiresAt: null });
      const { documentId } = await createOpeningNoteRepository(sql).saveSnippet(scope, {
        title: "Derived note", text: "Copied answer", savedTurnId,
      });
      await memories.deleteMemory(scope, { id: memory.id, expectedVersion: memory.version, deleteSourceText: false, clientKey: randomUUID() });
      await publishSnippet(fixture, documentId);
      const datasets = createOpeningDatasetRepository(sql);
      await datasets.grantConsent(scope, { consented: true, policyVersion: OPENING_DATASET_POLICY_VERSION,
        expiresAt: new Date(Date.now() + 60_000).toISOString() });
      expect((await datasets.read(scope)).coursePackageQuality).toEqual([]);
      await expect(createLibraryRepository(sql).getDocument({ workspaceId: scope.workspaceId, documentId }))
        .resolves.toMatchObject({ id: documentId });
    } finally { await fixture.close(); }
  });

  it("does not certify legacy ephemeral provenance on save", async () => {
    const fixture = await createOpeningFixture();
    try {
      const { sql, scope } = fixture;
      const requestId = randomUUID();
      const reservation = await createOpeningBudgetRepository(sql, { envCapCents: 10_000 }).reserve(scope, { purpose: "tutor", amountCents: 1, requestId });
      await sql`INSERT INTO opening_ephemeral_provenance(id,workspace_id,owner_user_id,privacy_epoch,context_source_refs)
        VALUES(${reservation.id},${scope.workspaceId},${scope.ownerUserId},0,'[]')`;
      const { documentId } = await createOpeningNoteRepository(sql).saveSnippet(scope, {
        title: "Legacy credential", text: "Personally readable", provenanceId: reservation.id,
      });
      expect(await sql`SELECT context_source_refs FROM opening_note_provenance WHERE document_id=${documentId}`)
        .toEqual([{ context_source_refs: [] }]);
      await expect(createLibraryRepository(sql).getDocument({ workspaceId: scope.workspaceId, documentId }))
        .resolves.toMatchObject({ id: documentId });
    } finally { await fixture.close(); }
  });

  it("rejects a legacy memory-only credential even beside an unrelated active dependency", async () => {
    const fixture = await createOpeningFixture();
    try {
      const { sql, scope } = fixture;
      const sourceId = await insertSource(sql, scope);
      const budget = createOpeningBudgetRepository(sql, { envCapCents: 10_000 });
      const reservation = await budget.reserve(scope, { purpose: "tutor", amountCents: 1, requestId: randomUUID() });
      await sql`INSERT INTO opening_ephemeral_provenance(id,workspace_id,owner_user_id,privacy_epoch,context_source_refs)
        VALUES(${reservation.id},${scope.workspaceId},${scope.ownerUserId},0,${sql.json([{ sourceId, sourceVersion: 0, memoryOnly: true }])})`;
      const id = await insertMemory(sql, scope, "Unrelated memory", [await insertOwnedTurn(sql, scope)]);
      const provenance = createOpeningEphemeralProvenanceRepository(sql);
      const provenanceId = await provenance.recordQuery!(scope, { requestId: randomUUID(), privacyEpoch: 0,
        contextSourceRefs: [{ memoryDependencyIds: [id] }] });
      await expect(provenance.resolveHistory(scope, [{ provenanceId: reservation.id }, { provenanceId }], 0)).resolves.toBeNull();
      await expect(provenance.recordQuery!(scope, { requestId: randomUUID(), privacyEpoch: 0,
        contextSourceRefs: [{ sourceId, sourceVersion: 0, memoryOnly: true }, { memoryDependencyIds: [id] }] }))
        .rejects.toMatchObject({ code: "PRIVACY_CHANGED" });
    } finally { await fixture.close(); }
  });

  it("rechecks source-free history when a query actually uses the previous question", async () => {
    const fixture = await createOpeningFixture();
    try {
      const { sql, scope } = fixture;
      const provenance = createOpeningEphemeralProvenanceRepository(sql);
      const provenanceId = await provenance.recordQuery!(scope, { requestId: randomUUID(), privacyEpoch: 0, contextSourceRefs: [] });
      const callModel = vi.fn(async (_owner: unknown, _request: unknown, context: { beforeSend?: () => Promise<void> }) => {
        await sql`UPDATE opening_query_ephemeral_provenance SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${provenanceId}`;
        await context.beforeSend?.();
        throw new Error("A stale referent reached dispatch");
      });
      await expect(replyEphemeralSystemQuery({
        systemQuery: createDbSystemQueryService(sql, "web", { callModel }), provenance,
      }, scope, { text: "刷新", purpose: "query", querySystem: true, mode: "listen", sourceIds: [],
        history: [{ role: "user", text: "有哪些笔记？", provenanceId }], historyPrivacyEpoch: 0 }))
        .rejects.toMatchObject({ code: "PRIVACY_CHANGED" });
      expect(callModel).toHaveBeenCalledTimes(1);
      expect(await sql`SELECT id FROM opening_query_ephemeral_provenance WHERE workspace_id=${scope.workspaceId}`)
        .toEqual([{ id: provenanceId }]);
    } finally { await fixture.close(); }
  });

  it("saves an ephemeral snippet with a live course-scoped memory", async () => {
    const fixture = await createOpeningFixture();
    try {
      const { sql, scope } = fixture;
      const course = await createCourseMembershipRepository(sql).createCourse({ workspaceId: scope.workspaceId, title: "Course", slug: randomUUID() });
      const id = await insertMemory(sql, scope, "Course memory", [await insertOwnedTurn(sql, scope)]);
      await sql`UPDATE opening_memories SET course_id=${course.id} WHERE id=${id}`;
      const requestId = randomUUID();
      const reservation = await createOpeningBudgetRepository(sql, { envCapCents: 10_000 }).reserve(scope, { purpose: "tutor", amountCents: 1, requestId });
      const provenanceId = await createOpeningEphemeralProvenanceRepository(sql).record(scope, {
        reservationId: reservation.id, requestId, privacyEpoch: 0, contextSourceRefs: [{ memoryDependencyIds: [id] }],
      });
      await expect(createOpeningNoteRepository(sql).saveSnippet(scope, {
        title: "Course snippet", text: "Answer", provenanceId: provenanceId!,
      })).resolves.toMatchObject({ documentId: expect.any(String) });
    } finally { await fixture.close(); }
  });

  it("exports a verified material-free ephemeral snippet", async () => {
    const fixture = await createOpeningFixture();
    try {
      const { sql, scope } = fixture;
      const requestId = randomUUID();
      const reservation = await createOpeningBudgetRepository(sql, { envCapCents: 10_000 }).reserve(scope, { purpose: "tutor", amountCents: 1, requestId });
      const provenanceId = await createOpeningEphemeralProvenanceRepository(sql).record(scope, {
        reservationId: reservation.id, requestId, privacyEpoch: 0, contextSourceRefs: [],
      });
      const { documentId } = await createOpeningNoteRepository(sql).saveSnippet(scope, {
        title: "Verified empty lineage", text: "Answer", provenanceId: provenanceId!,
      });
      await publishSnippet(fixture, documentId);
      const datasets = createOpeningDatasetRepository(sql);
      await datasets.grantConsent(scope, { policyVersion: OPENING_DATASET_POLICY_VERSION, consented: true,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
      const dataset = await datasets.read(scope);
      expect(dataset.coursePackageQuality).toHaveLength(1);
      expect(dataset.answerSequences).toHaveLength(1);
      expect(dataset.dialogueEvaluation.map(row => row.role)).toEqual(["assistant"]);
    } finally { await fixture.close(); }
  });

  it("uses the database snapshot time even when the JavaScript clock runs ahead", async () => {
    const fixture = await createOpeningFixture();
    try {
      const { sql, scope } = fixture;
      const sourceTurnId = await insertOwnedTurn(sql, scope);
      const { id } = await createOpeningMemoryRepository(sql).proposeMemory(scope, {
        text: "Temporary but still eligible", sourceTurnIds: [sourceTurnId],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      await insertOwnedTurn(sql, scope, { role: "assistant", contextSourceRefs: [{ memoryDependencyIds: [id] }] });
      const datasets = createOpeningDatasetRepository(sql);
      await datasets.grantConsent(scope, { policyVersion: OPENING_DATASET_POLICY_VERSION, consented: true,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
      const ahead = Date.now() + 120_000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(ahead);
      try {
        expect((await datasets.read(scope)).dialogueEvaluation.map(row => row.role).sort()).toEqual(["assistant", "user"]);
      } finally { clock.mockRestore(); }
    } finally { await fixture.close(); }
  });

  it.each(["notes", "cards"] as const)("paginates only admitted %s and collects only the returned page's lineage", async name => {
    const fixture = await createOpeningFixture();
    try {
      const { sql, scope } = fixture;
      const addRow = async (index: number, verified: boolean) => {
        const sourceId = await insertSource(sql, scope);
        await backupRows(sql, scope).chunk(sourceId, 0);
        const memoryId = await insertMemory(sql, scope, "Preference", [await insertOwnedTurn(sql, scope)]);
        const turnId = await insertOwnedTurn(sql, scope, { role: "assistant",
          contextSourceRefs: [{ sourceId, sourceVersion: 0 }, { memoryDependencyIds: [memoryId] }] });
        const { documentId } = await createOpeningNoteRepository(sql).saveSnippet(scope, {
          title: "Paginated note", text: "Answer", savedTurnId: turnId,
        });
        if (!verified) await sql`UPDATE opening_note_provenance SET context_source_refs='[]' WHERE document_id=${documentId}`;
        const card = await createCardRepository(sql).createCard({ ...scope, sourceDocumentId: documentId, front: "Prompt", back: "Answer" });
        await sql`UPDATE library_documents SET updated_at='2025-01-01'::timestamptz - ${index}::int * interval '1 day' WHERE id=${documentId}`;
        await sql`UPDATE card_review_states SET due_at='2025-01-01'::timestamptz + ${index}::int * interval '1 day' WHERE card_id=${card.id}`;
        return { id: name === "notes" ? documentId : card.id, sourceId, memoryId, turnId };
      };
      await addRow(0, false);
      await addRow(1, false);
      const collectLineage = vi.fn();
      const read = createScopedOpeningSystemQueryReader(sql, scope, { collectLineage });
      const page = (offset: number) => read({ name, arguments: { limit: 1, offset } }, new AbortController().signal);

      expect(await page(0)).toMatchObject({ status: "unknown", reason: "no_data", nextOffset: null, data: [], evidence: [], sourceRefs: [] });
      expect(collectLineage).not.toHaveBeenCalled();

      const admitted = await addRow(2, true);
      const second = await addRow(3, true);
      const third = await addRow(4, true);
      const checkPage = async (offset: number, row: typeof admitted, nextOffset: number | null) => {
        collectLineage.mockClear();
        const result = await page(offset);
        expect(result).toMatchObject({ status: nextOffset === null ? "ok" : "partial",
          reason: nextOffset === null ? "read" : "truncated", nextOffset,
          data: [{ id: row.id }], evidence: [{ recordId: row.id }], sourceRefs: [{ sourceId: row.sourceId, sourceVersion: 0 }] });
        expect(collectLineage).toHaveBeenCalledExactlyOnceWith({ memoryIds: [row.memoryId], originTurnIds: [row.turnId] });
      };
      await checkPage(0, admitted, 1);
      await checkPage(1, second, 2);
      await checkPage(2, third, null);
      expect(await page(3)).toMatchObject({ status: "unknown", reason: "no_data", nextOffset: null, data: [], evidence: [], sourceRefs: [] });
    } finally { await fixture.close(); }
  });

  it.each(["notes", "cards", "courses"] as const)("keeps %s pagination inside the request offset limit", async name => {
    const fixture = await createOpeningFixture();
    try {
      const { sql, scope } = fixture;
      if (name === "notes") {
        await sql`INSERT INTO library_documents(workspace_id,title,lifecycle)
          SELECT ${scope.workspaceId}, 'Note ' || n, 'confirmed' FROM generate_series(1,1002) n`;
      } else if (name === "cards") {
        await sql`INSERT INTO cards(workspace_id,owner_user_id,front,back)
          SELECT ${scope.workspaceId}, ${scope.ownerUserId}, 'Prompt ' || n, 'Answer' FROM generate_series(1,1002) n`;
      } else {
        await sql`INSERT INTO courses(workspace_id,title,slug)
          SELECT ${scope.workspaceId}, 'Course ' || n, 'course-' || n FROM generate_series(1,1002) n`;
      }
      const read = createScopedOpeningSystemQueryReader(sql, scope);
      const page = (offset: number) => read({ name, arguments: { offset, limit: 1 } }, new AbortController().signal);
      const next = await page(999);
      expect(next).toMatchObject({ status: "partial", reason: "truncated", nextOffset: 1000, data: [expect.any(Object)] });
      const final = await page(next.nextOffset!);
      expect(final).toMatchObject({ status: "partial", reason: "truncated", nextOffset: null, data: [expect.any(Object)] });
      expect(final.data).not.toEqual(next.data);
    } finally { await fixture.close(); }
  }, 30_000);

  it.each(["notes", "cards", "historical cards", "automatic cards"] as const)("carries %s memory lineage through the actual ephemeral query producer", async kind => {
    const name = kind === "notes" ? "notes" : "cards";
    const fixture = await createOpeningFixture();
    try {
      const { sql, scope } = fixture;
      const { id } = await createOpeningMemoryRepository(sql).proposeMemory(scope, { text: "Private preference",
        sourceTurnIds: [await insertOwnedTurn(sql, scope)], expiresAt: new Date(Date.now() + 60_000).toISOString() });
      const savedTurnId = await insertOwnedTurn(sql, scope, { role: "assistant",
        contextSourceRefs: [{ memoryDependencyIds: [id] }] });
      const { documentId } = await createOpeningNoteRepository(sql).saveSnippet(scope, {
        title: "Private preference note", text: "Do not deliver the note body", savedTurnId,
      });
      const card = await createCardRepository(sql).createCard({ ...scope,
        ...(kind === "historical cards" || kind === "automatic cards" ? {} : { sourceDocumentId: documentId }), front: "Question", back: "Answer" });
      if (kind === "historical cards") {
        await sql`UPDATE opening_note_provenance
          SET context_source_refs=context_source_refs || ${sql.json([{ publicationCardIds: [card.id] }])}::jsonb
          WHERE document_id=${documentId}`;
      }
      if (kind === "automatic cards") {
        const rows = backupRows(sql, scope);
        const session = await rows.learning();
        const observation = await rows.observation(session);
        const [stored] = await sql`SELECT activity_id FROM opening_learning_observations WHERE id=${observation}`;
        await publishSnippet(fixture, documentId, String(stored!.activity_id));
        await sql`UPDATE cards SET origin_observation_root_id=${observation} WHERE id=${card.id}`;
      }
      const provenance = createOpeningEphemeralProvenanceRepository(sql);
      const systemQuery = createDbSystemQueryService(sql, "web", {
        planner: async () => ({ text: "", inputTokens: null, outputTokens: null, requestId: null,
          toolCalls: [{ id: name, name, arguments: JSON.stringify({ limit: 5, offset: 0 }) }] }),
      });
      const reply = await replyEphemeralSystemQuery({ systemQuery, provenance }, scope, {
        text: name === "notes" ? "有哪些笔记？" : "有哪些复习卡片？",
        purpose: "query", querySystem: true, mode: "listen", sourceIds: [], history: [],
      });
      expect(reply.systemQuery?.results).toEqual(expect.arrayContaining([expect.objectContaining({
        name, sourceRefs: [], data: expect.arrayContaining([expect.any(Object)]),
      })]));
      const history = [{ provenanceId: reply.provenanceId! }];
      const admitted = await provenance.resolveHistory(scope, history, 0);
      expect(admitted).toEqual([{ memoryDependencyIds: [id] }]);
      expect(admitted?.originTurnIds).toEqual([savedTurnId]);
      expect(admitted?.verifiedLineage).toBe(true);
      if (kind === "notes") {
        const independent = await replyEphemeralSystemQuery({
          systemQuery: createDbSystemQueryService(sql, "web", { callModel: async () => { throw new Error("deterministic fixture"); } }), provenance,
        }, scope, { text: "我有哪些课程？", purpose: "query", querySystem: true, mode: "listen", sourceIds: [],
          history: [{ role: "user", text: "有哪些笔记？", provenanceId: reply.provenanceId! },
            { role: "assistant", text: reply.text, provenanceId: reply.provenanceId! }], historyPrivacyEpoch: 0 });
        await expect(provenance.resolveHistory(scope, [{ provenanceId: independent.provenanceId! }], 0)).resolves.toEqual([]);
      }
      await sql`UPDATE opening_memories SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${id}`;
      await expect(provenance.resolveHistory(scope, history, 0)).resolves.toBeNull();
    } finally { await fixture.close(); }
  });

  it.each(["transitive expiry", "archived course", "excluded backing source"] as const)(
    "rejects ephemeral credentials with %s", async reason => {
      const fixture = await createOpeningFixture();
      try {
        const { sql, scope } = fixture;
        const source = await insertSource(sql, scope);
        const sourceTurnId = await insertOwnedTurn(sql, scope, { sourceIds: [source] });
        const ancestor = await createOpeningMemoryRepository(sql).proposeMemory(scope, { text: "Temporary",
          sourceTurnIds: [sourceTurnId], expiresAt: new Date(Date.now() + 60_000).toISOString() });
        const dependentTurnId = await insertOwnedTurn(sql, scope, { role: "assistant",
          contextSourceRefs: [{ memoryDependencyIds: [ancestor.id] }] });
        const memoryId = await insertMemory(sql, scope, "Dependent", [dependentTurnId]);
        const provenance = createOpeningEphemeralProvenanceRepository(sql);
        const refs = [{ memoryDependencyIds: [memoryId] }];
        const recordQuery = () => provenance.recordQuery!(scope, { requestId: randomUUID(), privacyEpoch: 0, contextSourceRefs: refs });
        const provenanceId = await recordQuery();
        await expect(provenance.resolveHistory(scope, [{ provenanceId }], 0)).resolves.toEqual(refs);
        if (reason === "transitive expiry") {
          await sql`UPDATE opening_memories SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${ancestor.id}`;
        } else if (reason === "archived course") {
          const course = await createCourseMembershipRepository(sql).createCourse({ workspaceId: scope.workspaceId, title: "Old course", slug: randomUUID() });
          await sql`UPDATE opening_memories SET course_id=${course.id} WHERE id=${memoryId}`;
          await sql`UPDATE courses SET archived_at=clock_timestamp() WHERE id=${course.id}`;
        } else {
          await sql`INSERT INTO opening_privacy_exclusions(id,workspace_id,source_id,deleted_at)
            VALUES(${randomUUID()},${scope.workspaceId},${source},clock_timestamp())`;
        }
        await expect(provenance.resolveHistory(scope, [{ provenanceId }], 0)).resolves.toBeNull();
        await expect(recordQuery()).rejects.toMatchObject({ code: "PRIVACY_CHANGED" });
        const requestId = randomUUID();
        const reservation = await createOpeningBudgetRepository(sql, { envCapCents: 10_000 }).reserve(scope, { purpose: "tutor", amountCents: 1, requestId });
        await expect(provenance.record(scope, { reservationId: reservation.id, requestId, privacyEpoch: 0, contextSourceRefs: refs }))
          .rejects.toMatchObject({ code: "PRIVACY_CHANGED" });
      } finally { await fixture.close(); }
    },
  );
});
async function grantOther() { await repo.grantConsent(f.otherScope,{policyVersion:OPENING_DATASET_POLICY_VERSION,consented:true,expiresAt:new Date(Date.now() + 3600000).toISOString()}); }

async function publishSnippet({ sql, scope }: OpeningFixture, documentId: string, activityId?: string) {
  const activity = activityId ?? await insertTestTeachingActivity(sql, scope);
  const unit = randomUUID(), session = randomUUID();
  await sql`INSERT INTO opening_teaching_units(id,workspace_id,owner_user_id,title,document_id,current_revision_number)
    VALUES(${unit},${scope.workspaceId},${scope.ownerUserId},'Published snippet',${documentId},1)`;
  await sql`INSERT INTO opening_teaching_activity_specs(id,workspace_id,owner_user_id,activity_id,teaching_unit_id,document_id,
    revision_number,source_refs,version) VALUES(${randomUUID()},${scope.workspaceId},${scope.ownerUserId},${activity},${unit},${documentId},1,'[]',1)`;
  await sql`INSERT INTO opening_learning_sessions(id,workspace_id,owner_user_id,activity_id,skill_label)
    VALUES(${session},${scope.workspaceId},${scope.ownerUserId},${activity},'Published snippet')`;
  await sql`INSERT INTO opening_learning_attempts(id,workspace_id,owner_user_id,session_id,activity_id,skill_label,client_key,create_intent,history_revision)
    VALUES(${randomUUID()},${scope.workspaceId},${scope.ownerUserId},${session},${activity},'Published snippet',${randomUUID()},'{}',0)`;
  const turn = await insertOwnedTurn(sql, scope, { role: "assistant", contextSourceRefs: [] });
  await sql`UPDATE opening_turns SET learning_session_id=${session} WHERE id=${turn}`;
}
