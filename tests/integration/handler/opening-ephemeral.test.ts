import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { OpeningProviderError } from "@aistudy/ai";
import {
  complete,
  captureEphemeralLogs,
  tablesContainingEphemeralMarker,
  ephemeralCounts,
  postEphemeral,
  resetEphemeralRows,
  sql,
  startEphemeralHandler,
  stopEphemeralHandler,
  workspaceForCookie,
} from "./opening-ephemeral-harness";

beforeAll(startEphemeralHandler);
beforeEach(resetEphemeralRows);
afterAll(stopEphemeralHandler);

describe("POST /api/opening/ephemeral", () => {
  it("returns a stripped reply and writes no conversation, job, candidate, memory, or learning rows", async () => {
    const { POST } = await import("../../../apps/web/src/app/api/opening/ephemeral/route");
    const before = await ephemeralCounts();
    complete.mockResolvedValue({
      text: "listening",
      citedChunkIds: [],
      requestId: "req-handler",
      candidates: [{ kind: "task", title: "do homework", minutes: 15, dueText: null }],
      inputTokens: 4,
      outputTokens: 2,
    });
    const response = await POST(postEphemeral({
      text: "I am tired",
      sourceIds: [],
      mode: "listen",
      history: [{ role: "user", text: "earlier" }],
    }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.candidates).toEqual([]);
    expect(body.text).toBe("listening");
    expect(JSON.stringify(body)).not.toContain("do homework");
    const after = await ephemeralCounts();
    expect(after.conversations).toBe(before.conversations);
    expect(after.turns).toBe(before.turns);
    expect(after.jobs).toBe(before.jobs);
    expect(after.candidates).toBe(before.candidates);
    expect(after.memories).toBe(before.memories);
    expect(after.learning_sessions).toBe(before.learning_sessions);
    expect(after.learning_observations).toBe(before.learning_observations);
    expect(after.help_exposures).toBe(before.help_exposures);
    expect(after.reservations).toBe(before.reservations + 1);
  });

  it("strips think_together model candidates and does not save a fallback", async () => {
    const { POST } = await import("../../../apps/web/src/app/api/opening/ephemeral/route");
    complete.mockResolvedValue({
      text: "together",
      citedChunkIds: [],
      requestId: null,
      candidates: [{ kind: "memory", text: "likes hints", temporary: true }],
      inputTokens: 3,
      outputTokens: 1,
    });
    const response = await POST(postEphemeral({
      text: "think", sourceIds: [], mode: "think_together", history: [],
    }));
    expect(response.status).toBe(200);
    expect((await response.json()).candidates).toEqual([]);

    complete.mockRejectedValue(new OpeningProviderError("PROVIDER_UNAVAILABLE", "provider request failed", true));
    const failed = await POST(postEphemeral({
      text: "again", sourceIds: [], mode: "listen", history: [],
    }));
    expect(failed.status).toBeGreaterThanOrEqual(500);
    const after = await ephemeralCounts();
    expect(after.conversations).toBe(0);
    expect(after.turns).toBe(0);
    expect(after.jobs).toBe(0);
  });

  it("returns 400 for over-limit history and 404 for a foreign source", async () => {
    const { POST } = await import("../../../apps/web/src/app/api/opening/ephemeral/route");
    const history = Array.from({ length: 17 }, () => ({ role: "user", text: "x" }));
    const limited = await POST(postEphemeral({
      text: "too long", sourceIds: [], mode: "listen", history,
    }));
    expect(limited.status).toBe(400);
    expect(complete).not.toHaveBeenCalled();

    const denied = await POST(postEphemeral({
      text: "foreign", sourceIds: [randomUUID()], mode: "listen", history: [],
    }));
    expect(denied.status).toBe(404);
    expect(complete).not.toHaveBeenCalled();
  });

  it("returns 401 without a session", async () => {
    const { POST } = await import("../../../apps/web/src/app/api/opening/ephemeral/route");
    const response = await POST(new Request("http://localhost/api/opening/ephemeral", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi", sourceIds: [], mode: "listen", history: [] }),
    }));
    expect(response.status).toBe(401);
  });

  it("keeps an authorized citation id and drops an unauthorized one", async () => {
    const { POST } = await import("../../../apps/web/src/app/api/opening/ephemeral/route");
    const workspaceId = await workspaceForCookie();
    const sourceId = randomUUID();
    const chunkId = randomUUID();
    await sql`
      INSERT INTO opening_sources (id, workspace_id, name, mime, bytes, sha256, version, upload_state, parse_state)
      VALUES (${sourceId}, ${workspaceId}, 'note.pdf', 'application/pdf', 12, ${"b".repeat(64)}, 0, 'uploaded', 'ready')
    `;
    await sql`
      INSERT INTO opening_source_chunks (id, source_id, source_version, page, text)
      VALUES (${chunkId}, ${sourceId}, 0, 1, ${"PRIVATE-QUOTE-DO-NOT-LOG"})
    `;
    complete.mockResolvedValue({
      text: "from the page",
      citedChunkIds: [chunkId, randomUUID()],
      requestId: "req-cite",
      candidates: [],
      inputTokens: 5,
      outputTokens: 2,
    });
    const response = await POST(postEphemeral({
      text: "explain this", sourceIds: [sourceId], chunkId, mode: "explain", history: [],
    }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.citedChunkIds).toEqual([chunkId]);
    expect(JSON.stringify(body)).not.toContain("PRIVATE-QUOTE");
    expect(JSON.stringify(complete.mock.calls[0]![0])).toContain("PRIVATE-QUOTE-DO-NOT-LOG");
  });

  it("aborts through the provider without creating saved conversation rows", async () => {
    const { POST } = await import("../../../apps/web/src/app/api/opening/ephemeral/route");
    const controller = new AbortController();
    let release: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      release = resolve;
    });
    complete.mockImplementation((_input: unknown, signal?: AbortSignal) => new Promise((_resolve, reject) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      release();
      signal?.addEventListener("abort", () => {
        reject(new OpeningProviderError("PROVIDER_ABORTED", "provider request aborted", false));
      }, { once: true });
    }));
    const pending = POST(postEphemeral({
      text: "stop", sourceIds: [], mode: "listen", history: [],
    }, controller.signal));
    await started;
    controller.abort();
    const response = await pending;
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(499);
    expect(body.error.code).toBe("PROVIDER_ABORTED");
    expect(body.error.message).not.toMatch(/stop|PRIVATE/);
    expect(JSON.stringify(body)).not.toContain("stop");
    const after = await ephemeralCounts();
    expect(after.conversations).toBe(0);
    expect(after.turns).toBe(0);
    expect(after.jobs).toBe(0);
    expect(after.candidates).toBe(0);
    expect(after.memories).toBe(0);
    expect(after.learning_sessions).toBe(0);
  });
});

async function seedEphemeralSource(workspaceId: string, text: string) {
  const sourceId = randomUUID(), chunkId = randomUUID();
  await sql`INSERT INTO opening_sources(id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state)
    VALUES(${sourceId},${workspaceId},'note.pdf','application/pdf',12,${"a".repeat(64)},0,'uploaded','ready')`;
  await sql`INSERT INTO opening_source_chunks(id,source_id,source_version,page,text) VALUES(${chunkId},${sourceId},0,1,${text})`;
  return sourceId;
}
async function excludeThroughMemory(workspaceId: string, sourceId: string) {
  const { createOpeningMemoryRepository } = await import("@aistudy/database");
  const ownerUserId = (await sql`SELECT owner_user_id FROM workspaces WHERE id=${workspaceId}`)[0]!.owner_user_id as string;
  const conversationId = randomUUID(), turnId = randomUUID();
  await sql`INSERT INTO opening_conversations(id,workspace_id,owner_user_id,title) VALUES(${conversationId},${workspaceId},${ownerUserId},'privacy action')`;
  await sql`INSERT INTO opening_turns(id,workspace_id,conversation_id,role,text,mode,status,source_ids)
    VALUES(${turnId},${workspaceId},${conversationId},'user','origin','listen','complete',${[sourceId]})`;
  const memories = createOpeningMemoryRepository(sql);
  const scope = { workspaceId, ownerUserId };
  const memory = await memories.proposeMemory(scope, { text: 'private memory', sourceTurnIds: [turnId], expiresAt: null });
  return memories.deleteMemory(scope, { id: memory.id, expectedVersion: memory.version, deleteSourceText: false, clientKey: randomUUID() });
}

it("filters real privacy exclusions in mixed ephemeral material without changing ordinary source reads", async () => {
  const { POST } = await import("../../../apps/web/src/app/api/opening/ephemeral/route");
  const { createOpeningSourceChunksRepository } = await import("@aistudy/database");
  const workspaceId = await workspaceForCookie();
  const privateId = await seedEphemeralSource(workspaceId, "PRIVATE-EXCLUDED-CONTENT");
  const allowedId = await seedEphemeralSource(workspaceId, "allowed content");
  const receipt = await excludeThroughMemory(workspaceId, privateId);
  const before = await ephemeralCounts();
  complete.mockResolvedValue({ text: 'allowed answer', candidates: [], citedChunkIds: [], requestId: 'mixed', inputTokens: 3, outputTokens: 1 });
  const response = await POST(postEphemeral({ text: 'explain', sourceIds: [privateId, allowedId], currentPage: 1, mode: 'explain', history: [] }));
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toMatchObject({ privacyEpoch: receipt.privacyEpoch, historyDiscarded: false });
  expect(complete.mock.calls[0]![0]!.chunks.map((chunk: { sourceId: string }) => chunk.sourceId)).toEqual([allowedId]);
  expect(JSON.stringify(complete.mock.calls[0]![0])).not.toContain('PRIVATE-EXCLUDED-CONTENT');
  const ownerUserId = (await sql`SELECT owner_user_id FROM workspaces WHERE id=${workspaceId}`)[0]!.owner_user_id as string;
  const readable = await createOpeningSourceChunksRepository(sql).listForSources({ workspaceId, ownerUserId }, [privateId]);
  expect(readable.map(chunk => chunk.text)).toEqual(['PRIVATE-EXCLUDED-CONTENT']);
  const after = await ephemeralCounts();
  expect(after).toEqual({ ...before, reservations: before.reservations + 1 });
});

it("isolates the previous temporary reply after real deletion advances the epoch", async () => {
  const { POST } = await import("../../../apps/web/src/app/api/opening/ephemeral/route");
  const workspaceId = await workspaceForCookie();
  const privateId = await seedEphemeralSource(workspaceId, 'PRIVATE-OLD-SOURCE');
  complete.mockResolvedValueOnce({ text: 'PRIVATE-OLD-REPLY', candidates: [], citedChunkIds: [], requestId: 'first', inputTokens: 3, outputTokens: 1 });
  const first = await POST(postEphemeral({ text: 'read', sourceIds: [privateId], currentPage: 1, mode: 'listen', history: [] }));
  expect(first.status).toBe(200);
  const previous = await first.json();
  const receipt = await excludeThroughMemory(workspaceId, privateId);
  complete.mockResolvedValueOnce({ text: 'new answer', candidates: [], citedChunkIds: [], requestId: 'second', inputTokens: 3, outputTokens: 1 });
  const second = await POST(postEphemeral({ text: 'next', sourceIds: [], mode: 'listen',
    history: [{ role: 'assistant', text: previous.text }], historyPrivacyEpoch: previous.privacyEpoch }));
  expect(second.status).toBe(200);
  expect(await second.json()).toMatchObject({ privacyEpoch: receipt.privacyEpoch, historyDiscarded: true });
  expect(complete.mock.calls[1]![0]!.history).toEqual([]);
  expect(JSON.stringify(complete.mock.calls[1]![0])).not.toContain('PRIVATE-OLD');
});

it.each(["missing", "invalid"] as const)("discards %s history receipts and issues usable provenance for the new reply", async receiptKind => {
  const { POST } = await import("../../../apps/web/src/app/api/opening/ephemeral/route");
  const workspaceId = await workspaceForCookie();
  const sourceId = await seedEphemeralSource(workspaceId, "CURRENT-ALLOWED-MATERIAL");
  const privacyEpoch = Number((await sql`SELECT privacy_epoch FROM workspaces WHERE id=${workspaceId}`)[0]!.privacy_epoch);
  complete.mockResolvedValue({ text: "fresh answer", candidates: [], citedChunkIds: [], requestId: "fresh", inputTokens: 3, outputTokens: 1 });
  const response = await POST(postEphemeral({
    text: "read this page", sourceIds: [sourceId], currentPage: 1, mode: "listen", historyPrivacyEpoch: privacyEpoch,
    history: [{ role: "assistant", text: "UNVERIFIED-OLD-HISTORY", ...(receiptKind === "invalid" ? { provenanceId: randomUUID() } : {}) }],
  }));
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.historyDiscarded).toBe(true);
  expect(body.provenanceId).toEqual(expect.any(String));
  expect(complete.mock.calls[0]![0]!.history).toEqual([]);
  expect(JSON.stringify(complete.mock.calls[0]![0])).not.toContain("UNVERIFIED-OLD-HISTORY");
  expect(complete.mock.calls[0]![0]!.chunks.map((chunk: { sourceId: string }) => chunk.sourceId)).toEqual([sourceId]);
  const receipt = (await sql`SELECT context_source_refs FROM opening_ephemeral_provenance WHERE id=${body.provenanceId}`)[0]!;
  expect(receipt.context_source_refs).toEqual([{ sourceId, sourceVersion: 0 }]);

  const followup = await POST(postEphemeral({
    text: "continue", sourceIds: [], mode: "listen", historyPrivacyEpoch: body.privacyEpoch,
    history: [{ role: "assistant", text: body.text, provenanceId: body.provenanceId }],
  }));
  expect(followup.status).toBe(200);
  expect((await followup.json()).historyDiscarded).toBe(false);
  expect(complete.mock.calls[1]![0]!.history).toEqual([{ role: "assistant", text: "fresh answer" }]);
});

it("rejects a revoked receipt even when the request supplies the latest privacy epoch", async () => {
  const { POST } = await import("../../../apps/web/src/app/api/opening/ephemeral/route");
  const workspaceId = await workspaceForCookie();
  const sourceId = await seedEphemeralSource(workspaceId, "REVOKED-SOURCE-MATERIAL");
  complete.mockResolvedValue({ text: "REVOKED-OLD-ANSWER", candidates: [], citedChunkIds: [], requestId: "old", inputTokens: 3, outputTokens: 1 });
  const first = await POST(postEphemeral({ text: "read this page", sourceIds: [sourceId], currentPage: 1, mode: "listen", history: [] }));
  expect(first.status).toBe(200);
  const prior = await first.json();
  expect(prior.provenanceId).toEqual(expect.any(String));
  const exclusion = await excludeThroughMemory(workspaceId, sourceId);
  complete.mockResolvedValue({ text: "new answer", candidates: [], citedChunkIds: [], requestId: "new", inputTokens: 3, outputTokens: 1 });
  const next = await POST(postEphemeral({
    text: "continue", sourceIds: [], mode: "listen", historyPrivacyEpoch: exclusion.privacyEpoch,
    history: [{ role: "assistant", text: prior.text, provenanceId: prior.provenanceId }],
  }));
  expect(next.status).toBe(200);
  expect((await next.json()).historyDiscarded).toBe(true);
  expect(complete.mock.calls[1]![0]!.history).toEqual([]);
  expect(JSON.stringify(complete.mock.calls[1]![0])).not.toContain("REVOKED");
});
it("rejects an all-excluded selection without reserving or sending", async () => {
  const { POST } = await import("../../../apps/web/src/app/api/opening/ephemeral/route");
  const workspaceId = await workspaceForCookie();
  const privateId = await seedEphemeralSource(workspaceId, 'private');
  await excludeThroughMemory(workspaceId, privateId);
  const before = await ephemeralCounts();
  const response = await POST(postEphemeral({ text: 'read', sourceIds: [privateId], mode: 'listen', history: [] }));
  expect(response.status).toBe(409);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toMatchObject({ error: { code: 'SOURCE_EXCLUDED' } });
  expect(complete).not.toHaveBeenCalled();
  expect(await ephemeralCounts()).toEqual(before);
});

it("refuses a foreign owner even without source material", async () => {
  const { getEphemeralTutorService } = await import("../../../apps/web/src/features/opening/runtime");
  const workspaceId = await workspaceForCookie();
  await expect(getEphemeralTutorService(sql).replyEphemeral({ workspaceId, ownerUserId: randomUUID() }, {
    text: 'read', sourceIds: [], mode: 'listen', history: [],
  })).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
  expect(complete).not.toHaveBeenCalled();
});

it.each(["success", "provider-error", "invalid-output", "aborted-before", "aborted-after"] as const)(
  "keeps ephemeral bodies out of notes, drafts, receipts, logs and recovery on %s", async outcome => {
    const { POST } = await import("../../../apps/web/src/app/api/opening/ephemeral/route");
    const { createLibraryRepository } = await import("@aistudy/database");
    const { createTodayResumeReader, loadTodayResumeState } = await import("../../../apps/web/src/features/opening/planning/today-service");
    const marker = `EPHEMERAL-${randomUUID()}`;
    const workspaceId = await workspaceForCookie();
    const owner = (await sql`SELECT owner_user_id, privacy_epoch FROM workspaces WHERE id=${workspaceId}`)[0]!;
    const library = createLibraryRepository(sql);
    const stableNote = await library.createDocument({ workspaceId, title: "Existing note", blocks: [{ id: randomUUID(), type: "paragraph", content: { text: "EXISTING-NOTE-UNCHANGED" } }] });
    const before = await ephemeralCounts();
    const logs = captureEphemeralLogs();
    const controller = new AbortController();
    let started!: () => void;
    const enteredProvider = new Promise<void>(resolve => { started = resolve; });
    complete.mockImplementation(async (_input: unknown, signal?: AbortSignal) => {
      started();
      if (outcome === "aborted-after") return new Promise((_resolve, reject) => {
        signal!.addEventListener("abort", () => reject(new OpeningProviderError("PROVIDER_ABORTED", `${marker}-cancelled`)), { once: true });
      });
      if (outcome === "provider-error") throw new OpeningProviderError("PROVIDER_NETWORK", `${marker}-provider-error`);
      return { text: outcome === "invalid-output" ? null : `${marker}-answer`, citedChunkIds: [], requestId: "safe-request-id",
        candidates: [{ kind: "memory", text: `${marker}-candidate`, temporary: false }], inputTokens: 2, outputTokens: 2 };
    });
    try {
      if (outcome === "aborted-before") controller.abort();
      const pending = POST(postEphemeral({ text: `${marker}-prompt`, sourceIds: [], mode: "listen",
        history: [{ role: "user", text: `${marker}-history` }], historyPrivacyEpoch: Number(owner.privacy_epoch) }, controller.signal));
      if (outcome === "aborted-after") { await enteredProvider; controller.abort(); }
      const response = await pending;
      const body = await response.json();
      expect(response.headers.get("cache-control")).toBe("no-store");
      if (outcome === "success") { expect(response.status).toBe(200); expect(body.text).toBe(`${marker}-answer`); }
      else { expect(response.status).toBeGreaterThanOrEqual(400); expect(JSON.stringify(body)).not.toContain(marker); }
      const after = await ephemeralCounts();
      expect(after).toEqual({ ...before, reservations: before.reservations + (outcome === "aborted-before" ? 0 : 1) });
      expect(await tablesContainingEphemeralMarker(marker)).toEqual([]);
      expect(logs.text()).not.toContain(marker);
      expect((await library.getDocument({ workspaceId, documentId: stableNote.id })).blocks).toEqual(stableNote.blocks);
      const resume = await loadTodayResumeState({ scope: { workspaceId, ownerUserId: String(owner.owner_user_id) }, reader: createTodayResumeReader(sql) });
      expect(resume.kind).toBe("empty");
      expect(JSON.stringify(resume)).not.toContain(marker);
    } finally { logs.restore(); }
  },
);
