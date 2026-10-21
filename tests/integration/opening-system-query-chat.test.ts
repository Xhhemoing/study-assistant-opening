import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ephemeralTurnResponseSchema, type EphemeralTurnInput } from "@aistudy/contracts";
import { applyOpeningRestore, createOpeningEphemeralProvenanceRepository, createOpeningPrivacyRepository, createOpeningTutorJobsRepository } from "@aistudy/database";
import { validateOpeningRestore, type OpeningBackup } from "@aistudy/domain";
import { readOpeningBackupRecords } from "../../packages/database/src/repositories/opening-backup-records";
import { getEphemeralTutorService, getTutorService } from "../../apps/web/src/features/opening/runtime";
import { createTutorTurnHandler } from "../../apps/worker/src/jobs/tutor-turn";
import { createDbSystemQueryService } from "../../apps/worker/src/runtime/system-query";
import { replyEphemeralSystemQuery } from "../../apps/web/src/features/opening/tutor/ephemeral-system-query";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";
import { backupRows } from "./opening-backup-records-fixture";

let fixture: OpeningFixture;
const forbidden = vi.fn(async (): Promise<never> => { throw new Error("query entered model/RAG/budget path"); });
const ephemeral = (extra: Partial<EphemeralTurnInput> = {}): EphemeralTurnInput => ({ querySystem: true, text: "模型设置生效了吗", sourceIds: [], mode: "explain", history: [], ...extra });
function handler(systemQuery = createDbSystemQueryService(fixture.sql, "worker")) {
  return createTutorTurnHandler({ systemQuery, tutorJobs: createOpeningTutorJobsRepository(fixture.sql),
    chunks: { listForSources: forbidden, listChunksAtVersion: forbidden }, provider: { complete: forbidden }, resolveModel: forbidden,
    budget: { reserve: forbidden, release: forbidden, claimExecution: forbidden, settle: forbidden, markUnknown: forbidden },
    privacy: createOpeningPrivacyRepository(fixture.sql),
    config: { maxContextCharacters: 12000, reservedCents: 1, maxOutputTokens: 100, inputCentsPerMillion: 1, outputCentsPerMillion: 1 } });
}
async function counts() {
  const [row] = await fixture.sql`SELECT
    (SELECT count(*)::int FROM opening_learning_observations WHERE workspace_id=${fixture.scope.workspaceId}) AS observations,
    (SELECT count(*)::int FROM opening_learning_sessions WHERE workspace_id=${fixture.scope.workspaceId}) AS sessions,
    (SELECT count(*)::int FROM opening_help_exposures WHERE workspace_id=${fixture.scope.workspaceId}) AS help,
    (SELECT count(*)::int FROM opening_assistant_candidates WHERE workspace_id=${fixture.scope.workspaceId}) AS candidates,
    (SELECT count(*)::int FROM opening_budget_reservations WHERE workspace_id=${fixture.scope.workspaceId}) AS reservations`;
  return row;
}
beforeEach(async () => {
  fixture = await createOpeningFixture(); forbidden.mockClear();
  vi.stubEnv("OPENING_SYSTEM_QUERY", "1"); vi.stubEnv("OPENING_MODEL_API_KEY", "");
  // A query must work even when the model catalog is unusable. No provider fetch is allowed.
  vi.stubEnv("OPENING_MODEL_CATALOG", "invalid model catalog"); vi.stubGlobal("fetch", forbidden);
});
afterEach(async () => {
  vi.unstubAllEnvs(); vi.unstubAllGlobals();
  if (!fixture) return;
  try {
    await fixture.sql`TRUNCATE library_documents CASCADE`;
    const workspaces = [fixture.scope.workspaceId, fixture.otherScope.workspaceId], users = [fixture.scope.ownerUserId, fixture.otherScope.ownerUserId];
    await fixture.sql`UPDATE opening_turns SET attempt_id=NULL,learning_session_id=NULL WHERE workspace_id=ANY(${workspaces}::uuid[])`;
    await fixture.sql`DELETE FROM opening_learning_sessions WHERE workspace_id=ANY(${workspaces}::uuid[])`;
    await fixture.sql`DELETE FROM opening_learning_item_versions WHERE workspace_id=ANY(${workspaces}::uuid[])`;
    await fixture.sql`DELETE FROM courses WHERE workspace_id=ANY(${workspaces}::uuid[])`;
    await fixture.sql`DELETE FROM workspaces WHERE id=ANY(${workspaces}::uuid[])`;
    await fixture.sql`DELETE FROM sessions WHERE user_id=ANY(${users}::uuid[])`;
    await fixture.sql`DELETE FROM users WHERE id=ANY(${users}::uuid[])`;
  } finally { await fixture.close(); }
});

describe("saved and ephemeral record-query chat with real PostgreSQL", () => {
  it.each(["0", "1"])("persists a saved receipt exactly once without grading or charging (adaptive=%s)", async adaptive => {
    vi.stubEnv("OPENING_ADAPTIVE_PLANNING", adaptive);
    const f = await learningAttemptFixture(fixture); await f.submit(await f.start());
    const tutor = getTutorService(fixture.sql), conversation = await tutor.createConversation(fixture.scope, { title: "Query", courseId: f.courseId });
    const input = { conversationId: conversation.id, querySystem: true, text: "我的作答核验了吗", sourceIds: [], mode: "explain", privacy: "saved", clientKey: randomUUID() };
    const before = await counts(), queued = await tutor.submitTurn(fixture.scope, input);
    expect(queued.learningSessionId).toBeNull(); expect(queued.replayed).toBe(false);
    expect(await tutor.submitTurn(fixture.scope, input)).toEqual({ ...queued, replayed: true });
    const process = handler(); expect(await process(queued.jobId)).toEqual({ skipped: false });
    expect(await process(queued.jobId)).toEqual({ skipped: true });
    const turns = await tutor.listTurns(fixture.scope, conversation.id), assistant = turns.find(turn => turn.role === "assistant")!;
    expect(turns).toHaveLength(2); expect(assistant.status).toBe("complete");
    expect(assistant.systemQuery).toMatchObject({ mode: "deterministic", reason: "model_unavailable", privacyEpoch: 0,
      authorization: { purpose: "system_record_lookup", workspaceId: fixture.scope.workspaceId, principalId: fixture.scope.ownerUserId } });
    const learning = assistant.systemQuery!.results.find(result => result.name === "learning")!;
    expect(learning).toMatchObject({ name: "learning", sourceRefs: [{ sourceId: f.sourceId, sourceVersion: 1 }] });
    expect(learning.data[0]).toMatchObject({ answerWithheld: true, eligibility: { verifiedCorrect: "unknown" } });
    expect(learning.data[0]).not.toHaveProperty("answerExcerpt");
    expect(assistant.text).toContain("核验正确未知"); expect(assistant.citations).toEqual([]);
    expect(assistant.text).toContain("固定规则查询");
    expect(await counts()).toEqual(before); expect(forbidden).not.toHaveBeenCalled();
    // The same status request now resolves to the same read intent without a manual switch.
    expect(await tutor.submitTurn(fixture.scope, { ...input, querySystem: false })).toEqual({ ...queued, replayed: true });
    await expect(tutor.submitTurn(fixture.scope, { ...input, querySystem: false, text: "解释积分中值定理" })).rejects.toMatchObject({ code: "CONFLICT" });
    const [stored] = await fixture.sql`SELECT context_source_refs FROM opening_turns WHERE id=${assistant.id}`;
    expect(stored!.context_source_refs).toEqual([{ sourceId: f.sourceId, sourceVersion: 1 }]);
    await backupRows(fixture.sql, fixture.scope).exclude(f.sourceId);
    // AI exclusion preserves human history; asset deletion redacts the saved derivative.
    expect((await tutor.listTurns(fixture.scope, conversation.id)).find(turn => turn.id === assistant.id)!.systemQuery).not.toBeNull();
    await fixture.sql`UPDATE opening_privacy_exclusions SET asset_deleted_at=now() WHERE workspace_id=${fixture.scope.workspaceId} AND source_id=${f.sourceId}`;
    const redacted = (await tutor.listTurns(fixture.scope, conversation.id)).find(turn => turn.id === assistant.id)!;
    expect(redacted.systemQuery).toBeNull(); expect(redacted.text).not.toContain(assistant.text);
  });

  it.each(["0", "1"])("returns ephemeral process settings without catalog, budget or durable bodies (adaptive=%s)", async adaptive => {
    vi.stubEnv("OPENING_ADAPTIVE_PLANNING", adaptive);
    const before = await counts(), service = getEphemeralTutorService(fixture.sql), marker = `PRIVATE_QUERY_${randomUUID()}`;
    const response = ephemeralTurnResponseSchema.parse(await service.replyEphemeral(fixture.scope, ephemeral({ text: `模型设置 ${marker}` })));
    expect(response.systemQuery!.results[0].data[0]).toMatchObject({ process: "web", adaptivePlanning: adaptive === "1" });
    expect(response).toMatchObject({ requestId: null, inputTokens: null, outputTokens: null, candidates: [], citations: [], historyDiscarded: false });
    expect(response.provenanceId).toBeTruthy(); expect(await counts()).toEqual(before); expect(forbidden).not.toHaveBeenCalled();
    const [row] = await fixture.sql`SELECT * FROM opening_query_ephemeral_provenance WHERE id=${response.provenanceId!}`;
    expect(row).toMatchObject({ workspace_id: fixture.scope.workspaceId, owner_user_id: fixture.scope.ownerUserId, context_source_refs: [] });
    expect(JSON.stringify(row)).not.toContain(marker);
    expect(new Date(row!.expires_at).getTime() - new Date(row!.created_at).getTime()).toBe(86400000);
    const [durable] = await fixture.sql`SELECT (SELECT count(*)::int FROM opening_turns WHERE workspace_id=${fixture.scope.workspaceId}) AS turns,
      (SELECT count(*)::int FROM opening_conversations WHERE workspace_id=${fixture.scope.workspaceId}) AS conversations`;
    expect(durable).toEqual({ turns: 0, conversations: 0 });
    const history = [{ role: "assistant" as const, text: "old claim is not authority", provenanceId: response.provenanceId! }];
    expect((await service.replyEphemeral(fixture.scope, ephemeral({ history, historyPrivacyEpoch: 0 }))).historyDiscarded).toBe(false);
    expect((await service.replyEphemeral(fixture.scope, ephemeral({ history: [{ ...history[0], provenanceId: randomUUID() }], historyPrivacyEpoch: 0 }))).historyDiscarded).toBe(true);
    await fixture.sql`UPDATE opening_query_ephemeral_provenance SET expires_at=now()-interval '1 second' WHERE id=${response.provenanceId!}`;
    expect((await service.replyEphemeral(fixture.scope, ephemeral({ history, historyPrivacyEpoch: 0 }))).historyDiscarded).toBe(true);
    expect(await createOpeningEphemeralProvenanceRepository(fixture.sql).purgeExpiredQueries!()).toBeGreaterThanOrEqual(1);
    expect(await fixture.sql`SELECT id FROM opening_query_ephemeral_provenance WHERE id=${response.provenanceId!}`).toHaveLength(0);
  });

  it("retains exact ephemeral material lineage and refuses history after a source change or revocation", async () => {
    const rows = backupRows(fixture.sql, fixture.scope), sourceId = await rows.source(); await rows.chunk(sourceId);
    const service = getEphemeralTutorService(fixture.sql);
    const response = await service.replyEphemeral(fixture.scope, ephemeral({ text: "材料在哪页", sourceIds: [sourceId], currentPage: 1 }));
    expect(response.systemQuery!.results[0]).toMatchObject({ name: "materials", sourceRefs: [{ sourceId, sourceVersion: 1 }] });
    expect(response.systemQuery!.results[0].data[0]).toMatchObject({ exposure: "content_withheld", physicalPage: 1 });
    expect(JSON.stringify(response)).not.toContain("source evidence");
    const repo = createOpeningEphemeralProvenanceRepository(fixture.sql), history = [{ provenanceId: response.provenanceId! }];
    expect(await repo.resolveHistory(fixture.scope, history, 0)).toEqual([{ sourceId, sourceVersion: 1 }]);
    expect(await repo.resolveHistory(fixture.otherScope, history, 0)).toBeNull();
    await fixture.sql`UPDATE opening_sources SET version=2 WHERE id=${sourceId}`;
    expect(await repo.resolveHistory(fixture.scope, history, 0)).toBeNull();
    await rows.exclude(sourceId);
    await expect(repo.recordQuery!(fixture.scope, { requestId: randomUUID(), privacyEpoch: 1, contextSourceRefs: [{ sourceId, sourceVersion: 1 }] })).rejects.toMatchObject({ code: "PRIVACY_CHANGED" });
  });

  it("does not persist a saved answer if privacy changes after reading", async () => {
    const f = await learningAttemptFixture(fixture); await f.submit(await f.start());
    const tutor = getTutorService(fixture.sql), conversation = await tutor.createConversation(fixture.scope, { title: "Race", courseId: f.courseId });
    const queued = await tutor.submitTurn(fixture.scope, { conversationId: conversation.id, text: "我的作答", sourceIds: [], mode: "explain", privacy: "saved", querySystem: true, clientKey: randomUUID() });
    const service = createDbSystemQueryService(fixture.sql, "worker");
    await expect(handler({ ...service, async reply(...args) { const result = await service.reply(...args); await backupRows(fixture.sql, fixture.scope).exclude(f.sourceId); return result; } })(queued.jobId)).rejects.toThrow(/grant changed|epoch drift/);
    const turns = await tutor.listTurns(fixture.scope, conversation.id), assistant = turns.find(turn => turn.role === "assistant")!;
    expect(assistant.status).toBe("failed"); expect(assistant.systemQuery).toBeNull(); expect(forbidden).not.toHaveBeenCalled();
  });

  it("refuses ephemeral preparation if privacy changes between query and provenance persistence", async () => {
    const rows = backupRows(fixture.sql, fixture.scope), sourceId = await rows.source(); await rows.chunk(sourceId);
    const service = createDbSystemQueryService(fixture.sql, "web");
    const systemQuery = { ...service, async reply(...args: Parameters<typeof service.reply>) { const result = await service.reply(...args); await rows.exclude(sourceId); return result; } };
    await expect(replyEphemeralSystemQuery({ systemQuery, provenance: createOpeningEphemeralProvenanceRepository(fixture.sql) }, fixture.scope,
      ephemeral({ text: "材料在哪页", sourceIds: [sourceId] }))).rejects.toMatchObject({ code: "PRIVACY_CHANGED", status: 409 });
    expect(await fixture.sql`SELECT id FROM opening_query_ephemeral_provenance WHERE workspace_id=${fixture.scope.workspaceId}`).toHaveLength(0);
    expect(forbidden).not.toHaveBeenCalled();
  });

  it("skips cancelled and ownership-revoked queued queries before reading", async () => {
    const tutor = getTutorService(fixture.sql), conversation = await tutor.createConversation(fixture.scope, { title: "Revoke", courseId: null });
    const input = { conversationId: conversation.id, text: "模型设置", sourceIds: [], mode: "listen", privacy: "saved", querySystem: true, clientKey: randomUUID() };
    const first = await tutor.submitTurn(fixture.scope, input), jobs = createOpeningTutorJobsRepository(fixture.sql);
    await jobs.cancel(fixture.scope, first.jobId); expect(await handler()(first.jobId)).toEqual({ skipped: true });
    const second = await tutor.submitTurn(fixture.scope, { ...input, clientKey: randomUUID() });
    await fixture.sql`DELETE FROM workspaces WHERE id=${fixture.otherScope.workspaceId}`;
    await fixture.sql`UPDATE workspaces SET owner_user_id=${fixture.otherScope.ownerUserId} WHERE id=${fixture.scope.workspaceId}`;
    expect(await handler()(second.jobId)).toEqual({ skipped: true }); expect(forbidden).not.toHaveBeenCalled();
  });

  it("rejects both chat paths when disabled and aborts ephemeral requests before storage", async () => {
    const tutor = getTutorService(fixture.sql), conversation = await tutor.createConversation(fixture.scope, { title: "Disabled", courseId: null });
    vi.stubEnv("OPENING_SYSTEM_QUERY", "0");
    await expect(tutor.submitTurn(fixture.scope, { conversationId: conversation.id, text: "模型设置", sourceIds: [], mode: "listen", privacy: "saved", querySystem: true, clientKey: randomUUID() })).rejects.toMatchObject({ status: 409 });
    await expect(getEphemeralTutorService(fixture.sql).replyEphemeral(fixture.scope, ephemeral())).rejects.toMatchObject({ status: 409 });
    vi.stubEnv("OPENING_SYSTEM_QUERY", "1"); const controller = new AbortController(); controller.abort();
    await expect(getEphemeralTutorService(fixture.sql).replyEphemeral(fixture.scope, ephemeral(), controller.signal)).rejects.toMatchObject({ status: 499 });
    expect(await fixture.sql`SELECT id FROM opening_query_ephemeral_provenance WHERE workspace_id=${fixture.scope.workspaceId}`).toHaveLength(0);
    expect(forbidden).not.toHaveBeenCalled();
  });

  it("round-trips saved receipt and intent through the real backup executor, excluding ephemeral metadata", async () => {
    const tutor = getTutorService(fixture.sql), conversation = await tutor.createConversation(fixture.scope, { title: "Backup query", courseId: null });
    const queued = await tutor.submitTurn(fixture.scope, { conversationId: conversation.id, text: "模型设置", sourceIds: [], mode: "listen", privacy: "saved", querySystem: true, clientKey: randomUUID() });
    await handler()(queued.jobId);
    await getEphemeralTutorService(fixture.sql).replyEphemeral(fixture.scope, ephemeral());
    const before = await tutor.listTurns(fixture.scope, conversation.id), snapshot = await readOpeningBackupRecords(fixture.sql, fixture.scope);
    expect(snapshot.tables).not.toHaveProperty("opening_query_ephemeral_provenance");
    const backup: OpeningBackup = JSON.parse(JSON.stringify({ format: "opening-backup", version: 1, workspaceId: fixture.scope.workspaceId, ...snapshot, objects: [] }));
    expect(validateOpeningRestore(backup, [], snapshot.memoryDeletions).errors).toEqual([]);
    const corrupted = structuredClone(backup), row = (corrupted.tables.opening_turns as Record<string, unknown>[]).find(turn => turn.role === "assistant")!;
    row.query_system = false;
    expect(validateOpeningRestore(corrupted, [], snapshot.memoryDeletions).errors).toContain("turn query receipt is invalid");
    await fixture.sql`DELETE FROM opening_conversations WHERE id=${conversation.id}`;
    const restored = await applyOpeningRestore({ sql: fixture.sql, confirmLocalRestore: true, backup, currentDeletionJournal: snapshot.deletionJournal, currentMemoryDeletions: snapshot.memoryDeletions });
    expect(restored).toMatchObject({ ok: true, code: "APPLY_OK" });
    // Queue/job rows are deliberately not restored; compare persisted records by identity.
    expect(Object.fromEntries((await tutor.listTurns(fixture.scope, conversation.id)).map(turn => [turn.id, turn])))
      .toEqual(Object.fromEntries(before.map(turn => [turn.id, turn])));
    const [intent] = await fixture.sql`SELECT query_system FROM opening_turns WHERE id=${queued.turnId}`;
    expect(intent!.query_system).toBe(true); expect(forbidden).not.toHaveBeenCalled();
  });
});
