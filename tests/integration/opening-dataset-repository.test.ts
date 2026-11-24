import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOpeningDatasetRepository } from "../../packages/database/src/repositories/opening-dataset";
import { OPENING_DATASET_POLICY_VERSION } from "@aistudy/contracts";
import { createLibraryRepository, createOpeningBudgetRepository, createOpeningEphemeralProvenanceRepository,
  createOpeningPrivacyRepository, createOpeningMemoryRepository, createOpeningNoteRepository } from "@aistudy/database";
import { createEphemeralTutorService } from "../../apps/web/src/features/opening/tutor/ephemeral-service";
import { createOpeningFixture, insertTestTeachingActivity, type OpeningFixture } from "./opening-fixture";
import { insertOwnedTurn } from "./opening-memory-context-fixture";

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
            .toEqual([{ context_source_refs: memoryRefs }]);
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

  it("keeps a pre-upgrade empty snippet readable while excluding it from republished exports", async () => {
    const fixture = await createOpeningFixture();
    try {
      const { sql, scope } = fixture;
      const datasets = createOpeningDatasetRepository(sql);
      const savedTurnId = await insertOwnedTurn(sql, scope, { role: "assistant", contextSourceRefs: [] });
      const { documentId } = await createOpeningNoteRepository(sql).saveSnippet(scope, {
        title: "Old snippet", text: "Old answer", savedTurnId,
      });
      await sql`UPDATE opening_note_provenance SET context_source_refs='[]'::jsonb WHERE document_id=${documentId}`;
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
});
async function grantOther() { await repo.grantConsent(f.otherScope,{policyVersion:OPENING_DATASET_POLICY_VERSION,consented:true,expiresAt:new Date(Date.now() + 3600000).toISOString()}); }

async function publishSnippet({ sql, scope }: OpeningFixture, documentId: string) {
  const activity = await insertTestTeachingActivity(sql, scope);
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
