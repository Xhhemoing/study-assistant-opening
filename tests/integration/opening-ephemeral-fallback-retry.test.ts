import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { OpeningProviderError, runBudgetedCall, type BudgetedRepository, type ResolvedTaskModel } from "@aistudy/ai";
import { createOpeningBudgetRepository, createOpeningEphemeralProvenanceRepository } from "@aistudy/database";
import { createEphemeralTutorService } from "../../apps/web/src/features/opening/tutor/ephemeral-service";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

let f: OpeningFixture;
beforeAll(async () => { f = await createOpeningFixture(); });
afterAll(async () => { await f?.close(); });

function ledger() {
  const repo = createOpeningBudgetRepository(f.sql, { envCapCents: 100_000 });
  const budget: BudgetedRepository = {
    reserve: input => repo.reserve(f.scope, input),
    isParentNotSent: parentId => repo.isParentNotSent(f.scope, parentId),
    release: (key, reason) => repo.release(f.scope, key, reason),
    claimExecution: id => repo.claimExecution(f.scope, id),
    settle: (id, cents, options) => repo.settle(f.scope, id, cents, options),
    markUnknown: id => repo.markUnknown(f.scope, id),
  };
  return { repo, budget };
}

it.each(["old-to-new", "new-to-old", "unclaimed-legacy", "unclaimed-encoded"] as const)("reuses the paid reservation and its provenance for %s", async scenario => {
  const { repo, budget } = ledger();
  const scope = f.scope;
  const clientKey = `lesson-${scenario}-${randomUUID()}`;
  const requestId = `eph:${clientKey}`;
  const parentBudget = { id: `study-ephemeral:${scope.workspaceId}:${clientKey}` };
  const storedKey = scenario === "unclaimed-encoded"
    ? `eph-v2:${scope.workspaceId}:${Buffer.from(clientKey, "utf16le").toString("base64url")}` : requestId;
  const provider = { complete: vi.fn(async () => ({
    text: "answered", citedChunkIds: [], candidates: [], requestId: "upstream-receipt", inputTokens: 1, outputTokens: 1,
  })) };
  const provenance = createOpeningEphemeralProvenanceRepository(f.sql);
  const service = createEphemeralTutorService({
    budget, provider, provenance, sources: { listOwnedIds: async () => [] }, chunks: { listForSources: async () => [] },
    privacy: { snapshot: async () => ({ epoch: 0, excludedSourceIds: [] }), currentEpoch: async () => 0 },
    config: { maxContextCharacters: 1000, maxOutputTokens: 32, reservedCents: 10, inputCentsPerMillion: 1, outputCentsPerMillion: 1 },
  });
  const request = { text: "Explain", sourceIds: [], history: [], clientKey };
  // The deployed version reserves and reads the exact legacy key.
  const legacyCall = () => runBudgetedCall({ provider, budget, parentBudget, requestFamily: null,
    requestId, reservedCents: 10, actualCents: () => 1,
    input: { text: request.text, instruction: "Explain", mode: "explain", chunks: [], maxOutputTokens: 32, mediaCapability: "text_only", imageParts: [] },
  });
  let existingId: string | undefined;
  if (scenario === "old-to-new") {
    await legacyCall();
    existingId = (await repo.reserve(scope, { purpose: "tutor", requestId, parentBudget, amountCents: 10 })).id;
    await provenance.record(scope, { requestId, privacyEpoch: 0, contextSourceRefs: [] });
    await expect(service.replyEphemeral(scope, request)).rejects.toMatchObject({ status: 409, code: "BUDGET_REPLAY_COMPLETED" });
  } else {
    if (scenario.startsWith("unclaimed-")) {
      existingId = (await repo.reserve(scope, { purpose: "tutor", requestId: storedKey, parentBudget, amountCents: 10 })).id;
    }
    const reply = await service.replyEphemeral(scope, request);
    expect(reply).toMatchObject({ text: "answered", provenanceId: expect.any(String) });
    if (existingId) expect(reply.provenanceId).toBe(existingId);
    existingId = reply.provenanceId!;
    await expect(service.replyEphemeral(scope, request)).rejects.toMatchObject({ status: 409, code: "BUDGET_REPLAY_COMPLETED" });
    if (scenario === "new-to-old") await expect(legacyCall()).rejects.toMatchObject({ code: "BUDGET_REPLAY_COMPLETED" });
  }
  expect(provider.complete).toHaveBeenCalledOnce();
  const rows = await f.sql`SELECT id, request_id, state, amount_cents FROM opening_budget_reservations
    WHERE workspace_id=${scope.workspaceId} AND parent_interaction_id=${parentBudget.id}`;
  expect(rows).toEqual([{ id: existingId, request_id: storedKey, state: "completed", amount_cents: 1 }]);
  expect(await provenance.resolveHistory(scope, [{ provenanceId: existingId }], 0)).toEqual([]);
});

it.each(["unknown", "completed", "not_sent"] as const)("keeps the whole operation's %s fallback history after the user removes that route", async outcome => {
  const { budget } = ledger();
  const primaryCall = vi.fn(async () => { throw new OpeningProviderError("PROVIDER_AUTH", "bad credentials"); });
  const fallbackCall = vi.fn(async () => {
    if (outcome !== "completed") throw new OpeningProviderError(outcome === "unknown" ? "PROVIDER_TIMEOUT" : "PROVIDER_AUTH", "controlled fallback");
    return { text: "answered", citedChunkIds: [], candidates: [], requestId: "receipt", inputTokens: 1, outputTokens: 1 };
  });
  const model = (name: string, complete: ResolvedTaskModel["provider"]["complete"]): ResolvedTaskModel => ({
    provider: { complete }, inputCentsPerMillion: 1, outputCentsPerMillion: 1,
    modelSnapshot: { id: name, providerId: "controlled", modelName: name, inputCentsPerMillion: 1, outputCentsPerMillion: 1 },
  });
  const primary = model("primary", primaryCall), fallback = model("fallback", fallbackCall);
  let configuredFallback: ResolvedTaskModel | null = fallback;
  const service = createEphemeralTutorService({
    budget, provider: null, resolveModel: async () => primary, resolveFallbackModel: async () => configuredFallback,
    sources: { listOwnedIds: async (_scope, ids) => ids }, chunks: { listForSources: async () => [] },
    privacy: { snapshot: async () => ({ epoch: 0, excludedSourceIds: [] }), currentEpoch: async () => 0 },
    config: { maxContextCharacters: 1000, maxOutputTokens: 32, reservedCents: 10, inputCentsPerMillion: 1, outputCentsPerMillion: 1 },
  });
  const key = randomUUID(), request = { text: "同一个原问题", sourceIds: [], history: [], clientKey: key };
  const first = await service.replyEphemeral(f.scope, request).catch((error: unknown) => error);
  expect(primaryCall).toHaveBeenCalledOnce(); expect(fallbackCall).toHaveBeenCalledOnce();
  if (outcome === "unknown") expect(first).toMatchObject({ code: "PROVIDER_TIMEOUT" });
  if (outcome === "completed") expect(first).toMatchObject({ text: "answered" });
  const before = await f.sql`SELECT request_id, state, release_reason, outcome_unknown_at FROM opening_budget_reservations
    WHERE workspace_id=${f.scope.workspaceId} AND parent_interaction_id=${`study-ephemeral:${f.scope.workspaceId}:${key}`} ORDER BY request_id`;
  expect(before).toHaveLength(2);
  expect(before[0]).toMatchObject({ request_id: `eph:${key}`, state: "released", release_reason: "not_sent" });
  expect(before[1]).toMatchObject({ request_id: `eph:${key}:fallback`, state: outcome === "completed" ? "completed" : outcome === "unknown" ? "reserved" : "released" });
  if (outcome === "unknown") expect(before[1]!.outcome_unknown_at).not.toBeNull();
  configuredFallback = null; // Normal settings change; the primary snapshot stays identical.
  const replay = await service.replyEphemeral(f.scope, request).catch((error: unknown) => error);
  const mayIssueNewKey = (replay as { code?: string }).code === "EPHEMERAL_REQUEST_NOT_SENT";
  expect(mayIssueNewKey).toBe(outcome === "not_sent");
  expect(primaryCall).toHaveBeenCalledOnce(); expect(fallbackCall).toHaveBeenCalledOnce();
  const after = await f.sql`SELECT request_id, state, release_reason, outcome_unknown_at FROM opening_budget_reservations
    WHERE workspace_id=${f.scope.workspaceId} AND parent_interaction_id=${`study-ephemeral:${f.scope.workspaceId}:${key}`} ORDER BY request_id`;
  expect(after).toEqual(before);
  if (mayIssueNewKey) {
    await service.replyEphemeral(f.scope, { ...request, clientKey: randomUUID() }).catch(() => undefined);
    expect(primaryCall).toHaveBeenCalledTimes(2); expect(fallbackCall).toHaveBeenCalledOnce();
  }
});
