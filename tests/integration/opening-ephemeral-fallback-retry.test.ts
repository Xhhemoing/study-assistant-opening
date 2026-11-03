import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { OpeningProviderError, type BudgetedRepository, type ResolvedTaskModel } from "@aistudy/ai";
import { createOpeningBudgetRepository } from "@aistudy/database";
import { createEphemeralTutorService } from "../../apps/web/src/features/opening/tutor/ephemeral-service";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

let f: OpeningFixture;
beforeAll(async () => { f = await createOpeningFixture(); });
afterAll(async () => { await f?.close(); });

it.each(["unknown", "completed", "not_sent"] as const)("keeps the whole operation's %s fallback history after the user removes that route", async outcome => {
  const repo = createOpeningBudgetRepository(f.sql, { envCapCents: 100_000 });
  const budget: BudgetedRepository = {
    reserve: input => repo.reserve(f.scope, input),
    isParentNotSent: parentId => repo.isParentNotSent(f.scope, parentId),
    release: (key, reason) => repo.release(f.scope, key, reason),
    claimExecution: id => repo.claimExecution(f.scope, id),
    settle: (id, cents, options) => repo.settle(f.scope, id, cents, options),
    markUnknown: id => repo.markUnknown(f.scope, id),
  };
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
