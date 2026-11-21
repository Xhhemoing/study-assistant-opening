import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCourseMembershipRepository, createOpeningBudgetRepository, createOpeningConversationRepository,
  createOpeningMemoryRepository, createOpeningPrivacyRepository,
  createOpeningSourceChunksRepository, createOpeningTutorJobsRepository,
} from "@aistudy/database";
import type { ProviderInput, ProviderOutput } from "@aistudy/contracts";
import { createTutorTurnHandler } from "../../apps/worker/src/jobs/tutor-turn";
import { createOpeningMaterialRetriever } from "../../apps/worker/src/runtime/material-retrieval";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

let f: OpeningFixture;
beforeAll(async () => { f = await createOpeningFixture(); });
beforeEach(async () => {
  await f.reset();
  await f.sql`TRUNCATE opening_memories, opening_privacy_exclusions RESTART IDENTITY CASCADE`;
});
afterAll(async () => { await f?.close(); });

async function source() {
  const id = randomUUID();
  await f.sql`INSERT INTO opening_sources
    (id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state)
    VALUES (${id},${f.scope.workspaceId},'secret.pdf','application/pdf',1,${"a".repeat(64)},0,'uploaded','ready')`;
  await createOpeningSourceChunksRepository(f.sql).replaceChunks(f.scope, {
    sourceId: id, sourceVersion: 0,
    chunks: [{ page: 1, slideLabel: null, startMs: null, endMs: null,
      text: "ancestor-secret-material", imageObjectKey: null }],
  });
  return id;
}
async function append(conversationId: string, sourceIds: string[] = [], text = "continue") {
  return createOpeningConversationRepository(f.sql).appendSavedTurn({
    scope: f.scope, conversationId, text, sourceIds, mode: "explain",
    clientKey: randomUUID(), learningSessionId: null, currentPage: null, chunkId: null,
  });
}
function handler(text: string, memoryText?: string) {
  const calls: ProviderInput[] = [];
  const provider = { complete: vi.fn(async (input: ProviderInput): Promise<ProviderOutput> => {
    calls.push(input);
    return { text, citedChunkIds: [], requestId: null, inputTokens: 20, outputTokens: 10,
      candidates: memoryText ? [{ kind: "memory", text: memoryText, temporary: false }] : [] };
  }) };
  const budget = createOpeningBudgetRepository(f.sql, { envCapCents: 100_000 });
  const run = createTutorTurnHandler({
    tutorJobs: createOpeningTutorJobsRepository(f.sql),
    chunks: createOpeningSourceChunksRepository(f.sql),
    budget,
    retrieveContext: createOpeningMaterialRetriever(f.sql, budget, null),
    privacy: createOpeningPrivacyRepository(f.sql), provider,
    memories: { listContext: (scope, now, activeCourseId) => createOpeningMemoryRepository(f.sql).listContext(scope, now, activeCourseId ?? null) },
    config: { maxContextCharacters: 12_000, reservedCents: 100, maxOutputTokens: 256,
      inputCentsPerMillion: 1, outputCentsPerMillion: 1 },
  });
  return { run, calls };
}

describe("saved tutor material provenance", () => {
  it("carries matching course memories through Worker completion and fences their exact IDs against the saved job", async () => {
    const { sql, scope } = f;
    const courses = createCourseMembershipRepository(sql);
    const conversations = createOpeningConversationRepository(sql);
    const jobs = createOpeningTutorJobsRepository(sql);
    const memories = createOpeningMemoryRepository(sql);
    const courseA = await courses.createCourse({ workspaceId: scope.workspaceId, title: "Tutor memory course A", slug: "tutor-memory-a" });
    const courseB = await courses.createCourse({ workspaceId: scope.workspaceId, title: "Tutor memory course B", slug: "tutor-memory-b" });
    const material = await source();
    const origin = await conversations.create(scope, { title: "Standalone origin", courseId: null });
    const evidence = await append(origin.id, [material]);
    const globalEvidence = await append(origin.id);
    const createMemory = async (courseId: string | null, sourceTurnId: string, text: string) => {
      const candidate = await memories.proposeMemory(scope, { courseId, text, sourceTurnIds: [sourceTurnId], expiresAt: null });
      return memories.confirm(scope, candidate.id, candidate.version, randomUUID());
    };
    const global = await createMemory(null, globalEvidence.turnId, "Global preference");
    const a = await createMemory(courseA.id, evidence.turnId, "Course A preference");
    const b = await createMemory(courseB.id, evidence.turnId, "Course B preference");
    const conversation = await conversations.create(scope, { title: "Use course A", courseId: courseA.id });
    const first = await append(conversation.id);
    const worker = handler("Course A response");
    await worker.run(first.jobId);
    expect(worker.calls[0]?.instruction).toContain(global.text);
    expect(worker.calls[0]?.instruction).toContain(a.text);
    expect(worker.calls[0]?.instruction).not.toContain(b.text);
    const [saved] = await sql`SELECT context_source_refs FROM opening_turns WHERE id=${first.assistantTurnId}`;
    const sourceRef = { sourceId: material, sourceVersion: 0, memoryOnly: true };
    expect(saved?.context_source_refs).toEqual([sourceRef, { memoryDependencyIds: [global.id, a.id].sort() }]);
    const completed = await jobs.get(scope, first.jobId);
    const metadataTarget = { scope, jobId: first.jobId, assistantTurnId: first.assistantTurnId, claimToken: completed?.claimToken };
    await expect(jobs.canAppendCompletedTurnCandidates(metadataTarget)).resolves.toBe(true);

    const pending = await append(origin.id);
    await sql`UPDATE opening_turns SET context_anchor=${sql.json({ purpose: "learning_help", courseId: courseA.id.toUpperCase() })} WHERE id=${pending.turnId}`;
    const claim = (await jobs.claim(pending.jobId))!;
    const send = { claimToken: claim.claimToken, executionId: claim.executionId, contextSourceRefs: [sourceRef],
      memoryLineageSourceIds: [material], globalMemoryIds: [a.id] };
    await expect(jobs.assertGlobalMemoriesCurrent(scope, [global.id, a.id], pending.jobId)).resolves.toBeUndefined();
    await expect(jobs.assertGlobalMemoriesCurrent(scope, [a.id])).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(jobs.assertGlobalMemoriesCurrent(scope, [b.id], pending.jobId)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(jobs.assertSendAuthorized(scope, pending.jobId, send)).resolves.toBeUndefined();
    const membership = { workspaceId: scope.workspaceId, courseId: courseB.id, assetType: "source" as const, assetId: material };
    await courses.addAssetMembership({ ...membership, role: "core", purpose: "teaching", visibility: "course" });
    await expect(jobs.assertSendAuthorized(scope, pending.jobId, send)).rejects.toMatchObject({ code: "CONFLICT" });
    await courses.removeAssetMembership(membership);
    const sameCourse = { ...membership, courseId: courseA.id };
    await courses.addAssetMembership({ ...sameCourse, role: "core", purpose: "practice", visibility: "course" });
    await expect(jobs.assertSendAuthorized(scope, pending.jobId, send)).rejects.toMatchObject({ code: "CONFLICT" });
    await courses.removeAssetMembership(sameCourse);
    const publication = { ...send, privacyEpoch: await createOpeningPrivacyRepository(sql).getWorkspaceEpoch(scope) };
    const publish = vi.fn(async () => {});
    await jobs.withStreamPublication(scope, pending.jobId, publication, publish);
    expect(publish).toHaveBeenCalledOnce();
    const deliver = vi.fn();
    await jobs.readStream(scope, pending.jobId, { ...publication, exposureReceiptId: null }, deliver);
    expect(deliver).toHaveBeenCalledOnce();
    await expect(jobs.withStreamPublication(scope, pending.jobId,
      { ...publication, privacyEpoch: publication.privacyEpoch + 1 }, publish)).rejects.toMatchObject({ code: "PRIVACY_EPOCH_MISMATCH" });
    await sql`UPDATE opening_sources SET upload_state='rejected' WHERE id=${material}`;
    await expect(jobs.assertSendAuthorized(scope, pending.jobId, send)).rejects.toMatchObject({ code: "CONFLICT" });
    await sql`UPDATE opening_sources SET upload_state='uploaded' WHERE id=${material}`;
    await sql`UPDATE opening_turns SET context_anchor=NULL WHERE id=${pending.turnId}`;
    await expect(jobs.assertGlobalMemoriesCurrent(scope, [a.id], pending.jobId)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(jobs.assertGlobalMemoriesCurrent(scope, [b.id], pending.jobId)).rejects.toMatchObject({ code: "CONFLICT" });
    await sql`UPDATE opening_turns SET context_anchor=${sql.json({ purpose: "learning_help", courseId: courseA.id })} WHERE id=${pending.turnId}`;

    const record = await conversations.appendSavedTurn({ scope, conversationId: conversation.id, querySystem: true,
      text: "What did I study?", mode: "explain", sourceIds: [], clientKey: randomUUID(),
      learningSessionId: null, currentPage: null, chunkId: null });
    const recordClaim = (await jobs.claim(record.jobId))!;
    const completion: Parameters<typeof jobs.completeTurn>[0] = {
      scope, jobId: record.jobId, assistantTurnId: record.assistantTurnId, claimToken: recordClaim.claimToken,
      text: "Saved record response", citations: [], candidates: [], contextSourceRefs: [],
      systemQuery: { authorization: { purpose: "system_record_lookup", workspaceId: scope.workspaceId,
        principalId: scope.ownerUserId, role: "workspace_owner", permissionRevision: "1" },
      version: "study-query-v1", asOf: new Date().toISOString(), privacyEpoch: publication.privacyEpoch,
      mode: "deterministic", status: "ok", reason: "read", results: [] },
    };
    await expect(jobs.completeTurn(completion, { globalMemoryIds: [b.id] })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(jobs.completeTurn(completion, { globalMemoryIds: [a.id] })).resolves.toBeUndefined();
    expect(await jobs.get(scope, record.jobId)).toMatchObject({ status: "succeeded" });

    await courses.setArchived({ ...scope, courseId: courseA.id, archived: true });
    await expect(jobs.assertGlobalMemoriesCurrent(scope, [a.id], pending.jobId)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(jobs.canAppendCompletedTurnCandidates(metadataTarget)).resolves.toBe(false);
  });

  it("carries material through a memory into another conversation and filters its later history", async () => {
    const id = await source();
    const conversations = createOpeningConversationRepository(f.sql);
    const memories = createOpeningMemoryRepository(f.sql);
    const firstConversation = await conversations.create(f.scope, { title: "first", courseId: null });
    // Exercise inherited provenance from material actually selected for the model.
    const first = await append(firstConversation.id, [id], "Explain ancestor material");
    const firstCall = handler("first-secret-answer", "first-secret-memory");
    await firstCall.run(first.jobId);
    expect(firstCall.calls[0]?.chunks).toEqual([expect.objectContaining({ sourceId: id, sourceVersion: 0 })]);
    const confirm = async (turnId: string) => {
      const rows = await f.sql<{ id: string }[]>`SELECT id FROM opening_assistant_candidates WHERE source_turn_id=${turnId}`;
      return memories.decideMemoryCandidate(f.scope, { id: rows[0]!.id,
        action: "confirm", expectedVersion: 0, expiresAt: null, clientKey: randomUUID() });
    };
    const firstMemory = await confirm(first.assistantTurnId);
    const secondConversation = await conversations.create(f.scope, { title: "second", courseId: null });
    const second = await append(secondConversation.id);
    const secondCall = handler("second-secret-answer", "second-secret-memory");
    await secondCall.run(second.jobId);
    expect(secondCall.calls[0]?.instruction).toContain("first-secret-memory");
    expect(secondCall.calls[0]?.history).toEqual([]);
    expect(secondCall.calls[0]?.chunks).toEqual([]);
    const secondMemory = await confirm(second.assistantTurnId);
    const refs = await f.sql<{ context_source_refs: unknown; source_ids: string[]; citations: unknown[] }[]>`
      SELECT context_source_refs, source_ids, citations FROM opening_turns WHERE id=${second.assistantTurnId}`;
    expect(refs[0]).toEqual({
      context_source_refs: [
        { sourceId: id, sourceVersion: 0, memoryOnly: true },
        { memoryDependencyIds: [firstMemory.id] },
      ],
      source_ids: [],
      citations: [],
    });
    const receipt = await memories.deleteMemory(f.scope, {
      id: secondMemory.id, expectedVersion: secondMemory.version, deleteSourceText: false, clientKey: randomUUID(),
    });
    expect(receipt.excludedSourceIds).toEqual([id]);
    await f.sql`UPDATE opening_turns SET created_at=now()-interval '1 hour' WHERE id IN (${second.turnId},${second.assistantTurnId})`;
    const third = await append(secondConversation.id);
    const thirdCall = handler("safe-new-answer");
    await thirdCall.run(third.jobId);
    expect(thirdCall.calls[0]?.history).toEqual([]);
    expect(thirdCall.calls[0]?.instruction).not.toContain("secret-memory");
    expect(await memories.listContext(f.scope, new Date().toISOString())).toEqual({ memories: [], sourceRefs: [] });
    const kept = await f.sql<{ text: string }[]>`SELECT text FROM opening_turns WHERE id=${second.assistantTurnId}`;
    expect(kept[0]?.text).toBe("second-secret-answer");
  });

  it("rejects candidate confirmation after an inherited source is excluded", async () => {
    const id = await source();
    const conversations = createOpeningConversationRepository(f.sql);
    const conversation = await conversations.create(f.scope, { title: "pending", courseId: null });
    const first = await append(conversation.id, [id]);
    await handler("secret-answer").run(first.jobId);
    await f.sql`UPDATE opening_turns SET created_at=now()-interval '1 hour' WHERE id IN (${first.turnId},${first.assistantTurnId})`;
    const second = await append(conversation.id);
    await handler("derived", "pending-secret-memory").run(second.jobId);
    const candidates = await f.sql<{ id: string; source_ids: string[] }[]>`SELECT id,source_ids FROM opening_assistant_candidates WHERE source_turn_id=${second.assistantTurnId}`;
    expect(candidates[0]?.source_ids).toEqual([id]);
    const memories = createOpeningMemoryRepository(f.sql);
    const marker = await memories.proposeMemory(f.scope, { text: "marker", sourceTurnIds: [first.turnId], expiresAt: null });
    await memories.deleteMemory(f.scope, { id: marker.id, expectedVersion: marker.version, deleteSourceText: false, clientKey: randomUUID() });
    await expect(memories.decideMemoryCandidate(f.scope, { id: candidates[0]!.id,
      action: "confirm", expectedVersion: 0, expiresAt: null, clientKey: randomUUID() })).rejects.toThrow(/excluded/);
    expect(await memories.get(f.scope, candidates[0]!.id)).toBeNull();
  });

  it("quarantines unknown old assistant history and memories without erasing their text", async () => {
    const conversations = createOpeningConversationRepository(f.sql);
    const conversation = await conversations.create(f.scope, { title: "legacy", courseId: null });
    const old = await append(conversation.id);
    await f.sql`UPDATE opening_turns SET status='complete', text='legacy-secret', context_source_refs=NULL,
      created_at=now()-interval '1 hour' WHERE id=${old.assistantTurnId}`;
    await f.sql`UPDATE opening_turns SET created_at=now()-interval '1 hour' WHERE id=${old.turnId}`;
    const memories = createOpeningMemoryRepository(f.sql);
    const proposed = await memories.proposeMemory(f.scope, { text: "legacy-memory", sourceTurnIds: [old.assistantTurnId], expiresAt: null });
    await memories.confirm(f.scope, proposed.id, proposed.version, randomUUID());
    const follow = await append(conversation.id);
    const call = handler("fresh");
    await call.run(follow.jobId);
    expect(call.calls[0]?.history).toEqual([]);
    expect(call.calls[0]?.instruction).not.toContain("legacy-memory");
    expect((await memories.list(f.scope)).map((item) => item.text)).toContain("legacy-memory");
    expect((await f.sql<{ text: string }[]>`SELECT text FROM opening_turns WHERE id=${old.assistantTurnId}`)[0]?.text).toBe("legacy-secret");
    const persisted = await f.sql<{ context_source_refs: unknown }[]>`SELECT context_source_refs FROM opening_turns WHERE id=${follow.assistantTurnId}`;
    expect(persisted[0]?.context_source_refs).toEqual([]);
  });

  it("keeps new source-free exchanges available for continuation", async () => {
    const conversations = createOpeningConversationRepository(f.sql);
    const conversation = await conversations.create(f.scope, { title: "free", courseId: null });
    const first = await append(conversation.id);
    await handler("source-free-answer").run(first.jobId);
    await f.sql`UPDATE opening_turns SET created_at=now()-interval '1 hour' WHERE id IN (${first.turnId},${first.assistantTurnId})`;
    const second = await append(conversation.id);
    const next = handler("continued");
    await next.run(second.jobId);
    expect(next.calls[0]?.history).toContainEqual({ role: "assistant", text: "source-free-answer" });
  });
  it("excludes a memory derived from source-free uncited history after its ancestor is excluded", async () => {
    const id = await source();
    const conversations = createOpeningConversationRepository(f.sql);
    const conversation = await conversations.create(f.scope, { title: "lineage", courseId: null });
    const first = await append(conversation.id, [id]);
    await handler("ancestor-secret-answer").run(first.jobId);
    await f.sql`UPDATE opening_turns SET created_at=now()-interval '1 hour'
      WHERE id IN (${first.turnId},${first.assistantTurnId})`;
    const second = await append(conversation.id);
    const generated = handler("inherited-answer", "inherited-secret-memory");
    await generated.run(second.jobId);
    expect(generated.calls[0]?.history).toContainEqual({ role: "assistant", text: "ancestor-secret-answer" });
    expect(generated.calls[0]?.chunks).toEqual([]);
    const candidates = await f.sql<{ id: string }[]>`SELECT id FROM opening_assistant_candidates
      WHERE source_turn_id=${second.assistantTurnId}`;
    const memories = createOpeningMemoryRepository(f.sql);
    const memory = await memories.decideMemoryCandidate(f.scope, {
      id: candidates[0]!.id, action: "confirm", expectedVersion: 0, expiresAt: null, clientKey: randomUUID(),
    });
    expect((await memories.listForContext(f.scope)).map((item) => item.id)).toContain(memory.id);
    const marker = await memories.proposeMemory(f.scope, {
      text: "delete ancestor", sourceTurnIds: [first.turnId], expiresAt: null,
    });
    await memories.deleteMemory(f.scope, {
      id: marker.id, expectedVersion: marker.version, deleteSourceText: false, clientKey: randomUUID(),
    });
    expect((await memories.listForContext(f.scope)).map((item) => item.id)).not.toContain(memory.id);
    const original = await f.sql<{ text: string }[]>`SELECT text FROM opening_turns WHERE id=${first.assistantTurnId}`;
    expect(original[0]?.text).toBe("ancestor-secret-answer");
  });
});
