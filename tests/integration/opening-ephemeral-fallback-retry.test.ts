import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { OpeningProviderError, runBudgetedCall, withModelFallback, type BudgetedRepository, type ResolvedTaskModel } from "@aistudy/ai";
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

function model(name: string, complete: ResolvedTaskModel["provider"]["complete"]): ResolvedTaskModel {
  return {
    provider: { complete }, inputCentsPerMillion: 1, outputCentsPerMillion: 1,
    modelSnapshot: { id: name, providerId: "controlled", modelName: name, inputCentsPerMillion: 1, outputCentsPerMillion: 1 },
  };
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
  expect(rows.filter(row => row.state === "completed")).toEqual([{ id: existingId, request_id: storedKey, state: "completed", amount_cents: 1 }]);
  expect(await provenance.resolveHistory(scope, [{ provenanceId: existingId }], 0)).toEqual([]);
});

it.each([
  { ordering: "primary first", winnerSuffix: "", rollbackSuffix: ":fallback" },
  { ordering: "legacy fallback first", winnerSuffix: ":fallback", rollbackSuffix: "" },
])("fences the rollback exact reader with $ordering", async ({ winnerSuffix, rollbackSuffix }) => {
  const { repo } = ledger();
  const { scope } = f;
  const clientKey = randomUUID(), requestFamily = `eph:${clientKey}`;
  const parentBudget = { id: `study-ephemeral:${scope.workspaceId}:${clientKey}` };
  const alternateRequestFamily = `eph-v2:${scope.workspaceId}:${Buffer.from(clientKey, "utf16le").toString("base64url")}`;
  const requestId = requestFamily + winnerSuffix, rollbackKey = requestFamily + rollbackSuffix;
  const terms = { purpose: "tutor", amountCents: 10 };
  // A pre-existing unparented fallback is adopted with its original ID.
  const legacy = winnerSuffix ? await repo.reserve(scope, { ...terms, requestId, requestFamily: null }) : null;
  const winner = await repo.reserve(scope, { ...terms, requestId, parentBudget, requestFamily, alternateRequestFamily });
  if (legacy) expect(winner.id).toBe(legacy.id);
  expect(await repo.claimExecution(scope, winner.id)).toBe(true);

  // 09a5f7b3 looks up the exact key and claims by row ID, with no sibling predicate.
  const [exact] = await f.sql`SELECT * FROM opening_budget_reservations WHERE request_id=${rollbackKey}`;
  expect(exact).toMatchObject({ workspace_id: scope.workspaceId, state: "released", amount_cents: 0, release_reason: "not_sent" });
  const rollbackClaim = await f.sql`UPDATE opening_budget_reservations
    SET execution_claimed_at=now(), updated_at=now()
    WHERE id=${exact!.id} AND workspace_id=${scope.workspaceId} AND state='reserved'
      AND execution_claimed_at IS NULL AND outcome_unknown_at IS NULL RETURNING id`;
  expect(rollbackClaim).toHaveLength(0);
  await repo.settle(scope, winner.id, 3);
  const paid = await f.sql`SELECT request_id, amount_cents FROM opening_budget_reservations
    WHERE workspace_id=${scope.workspaceId} AND parent_interaction_id=${parentBudget.id} AND state='completed'`;
  expect(paid).toEqual([{ request_id: requestId, amount_cents: 3 }]);
});

it("fences a rollback reader between reserve and claim and releases its unsent sibling", async () => {
  const { repo } = ledger();
  const { scope } = f;
  const clientKey = randomUUID();
  const requestId = `eph:${clientKey}`;
  const parentBudget = { id: `study-ephemeral:${scope.workspaceId}:${clientKey}` };
  const primary = await repo.reserve(scope, {
    purpose: "tutor", amountCents: 10, requestId, parentBudget,
    requestFamily: requestId,
    alternateRequestFamily: `eph-v2:${scope.workspaceId}:${Buffer.from(clientKey, "utf16le").toString("base64url")}`,
  });

  // This is the pause point between reserve and claimExecution. The old
  // rollback reader cannot reserve the fenced exact fallback key anymore.
  await expect(repo.reserve(scope, {
    purpose: "tutor", amountCents: 10, requestId: `${requestId}:fallback`, parentBudget, requestFamily: null,
  })).rejects.toMatchObject({ code: "BUDGET_EXECUTION_CLAIMED", disposition: { reservationId: primary.id } });

  let paidCalls = 0;
  expect(await repo.claimExecution(scope, primary.id)).toBe(true);
  paidCalls += 1;
  await repo.settle(scope, primary.id, 3);

  // Preserve coverage for a legacy active sibling that is observed by
  // claimExecution after reserve. The unsent primary must be released atomically.
  const secondaryKey = `eph:${randomUUID()}`;
  const secondaryParent = { id: `study-ephemeral:${scope.workspaceId}:${randomUUID()}` };
  const secondary = await repo.reserve(scope, {
    purpose: "tutor", amountCents: 10, requestId: secondaryKey, parentBudget: secondaryParent,
    requestFamily: secondaryKey,
    alternateRequestFamily: `eph-v2:${scope.workspaceId}:${Buffer.from(secondaryKey.slice(4), "utf16le").toString("base64url")}`,
  });
  await f.sql`UPDATE opening_budget_reservations SET state='reserved', amount_cents=10,
    reserved_amount_cents=10, release_reason=NULL WHERE request_id=${`${secondaryKey}:fallback`}`;
  expect(await repo.claimExecution(scope, secondary.id)).toBe(false);
  const [unsent] = await f.sql`SELECT state, amount_cents, release_reason FROM opening_budget_reservations WHERE id=${secondary.id}`;
  expect(unsent).toEqual({ state: "released", amount_cents: 0, release_reason: "not_sent" });
  expect(paidCalls).toBe(1);

  await f.sql`UPDATE opening_budget_reservations SET created_at=now()-interval '31 minutes' WHERE id=${secondary.id}`;
  await repo.reserve(scope, { purpose: "tutor", amountCents: 1, requestId: `tick-${clientKey}` });
  const completed = await f.sql`SELECT request_id, amount_cents FROM opening_budget_reservations
    WHERE workspace_id=${scope.workspaceId} AND state='completed' ORDER BY request_id`;
  expect(completed).toEqual([{ request_id: requestId, amount_cents: 3 }]);
});

it("keeps a shared exact key fenced when its first owner releases and reuses it for fallback", async () => {
  const { repo } = ledger();
  const { scope } = f;
  const terms = (clientKey: string) => ({
    purpose: "tutor", amountCents: 10,
    parentBudget: { id: `study-ephemeral:${scope.workspaceId}:${clientKey}` },
    requestFamily: `eph:${clientKey}`,
    alternateRequestFamily: `eph-v2:${scope.workspaceId}:${Buffer.from(clientKey, "utf16le").toString("base64url")}`,
  });
  const clientKey = randomUUID(), primary = terms(clientKey), other = terms(`${clientKey}:fallback`);
  const first = await repo.reserve(scope, { ...primary, requestId: primary.requestFamily });
  expect(await repo.claimExecution(scope, first.id)).toBe(true);
  const [fence] = await f.sql`SELECT id FROM opening_budget_reservations WHERE request_id=${other.requestFamily}`;
  const independent = await repo.reserve(scope, { ...other, requestId: other.requestFamily });
  expect(independent.requestId).toBe(other.alternateRequestFamily);
  expect(await repo.claimExecution(scope, independent.id)).toBe(true);
  await repo.settle(scope, independent.id, 2);

  await repo.release(scope, first.requestId, "not_sent");
  await expect(repo.reserve(scope, { ...other, requestFamily: null, requestId: other.requestFamily }))
    .rejects.toMatchObject({ code: "CONFLICT" });
  const fallback = await repo.reserve(scope, { ...primary, requestId: other.requestFamily });
  expect(fallback).toMatchObject({ id: fence!.id, state: "reserved", amountCents: 10 });
  expect(await repo.claimExecution(scope, fallback.id)).toBe(true);
  await repo.settle(scope, fallback.id, 3);
});

it.each(["pre-reservation failure", "released not_sent"] as const)("fences both rollback retry routes after %s", async primaryFailure => {
  const { budget } = ledger();
  const { scope } = f;
  const clientKey = randomUUID(), requestId = `eph:${clientKey}`;
  const parentBudget = { id: `study-ephemeral:${scope.workspaceId}:${clientKey}` };
  const notSent = new OpeningProviderError("PROVIDER_AUTH", "bad credentials");
  const primaryCall = vi.fn(async () => { throw notSent; });
  const paidCall = vi.fn(async () => ({
    text: "answered", citedChunkIds: [], candidates: [], requestId: "paid", inputTokens: 1, outputTokens: 1,
  }));
  const primary = model("primary", primaryCall), fallback = model("fallback", paidCall);
  const service = createEphemeralTutorService({
    budget, provider: null,
    resolveModel: async () => {
      if (primaryFailure === "pre-reservation failure") throw notSent;
      return primary;
    },
    resolveFallbackModel: async () => fallback,
    sources: { listOwnedIds: async () => [] }, chunks: { listForSources: async () => [] },
    privacy: { snapshot: async () => ({ epoch: 0, excludedSourceIds: [] }), currentEpoch: async () => 0 },
    config: { maxContextCharacters: 1000, maxOutputTokens: 32, reservedCents: 10, inputCentsPerMillion: 1, outputCentsPerMillion: 1 },
  });
  const request = { text: "Explain", sourceIds: [], history: [], clientKey };
  await expect(service.replyEphemeral(scope, request)).resolves.toMatchObject({ text: "answered" });
  expect(primaryCall).toHaveBeenCalledTimes(primaryFailure === "released not_sent" ? 1 : 0);
  expect(paidCall).toHaveBeenCalledOnce();

  // The rollback release checks the exact key, then may try the exact fallback
  // suffix on a released primary or when primary resolution fails.
  const recoveredPrimary = model("primary", paidCall);
  const legacyReserve = (route: ResolvedTaskModel, key: string) => runBudgetedCall({
    provider: route.provider, modelSnapshot: route.modelSnapshot, budget, parentBudget, requestFamily: null,
    requestId: key, reservedCents: 10, actualCents: () => 1,
    input: { text: request.text, instruction: "Explain", mode: "explain", chunks: [], maxOutputTokens: 32, mediaCapability: "text_only", imageParts: [] },
  });
  await expect(withModelFallback({
    primary: async () => recoveredPrimary, fallback: async () => fallback, operationId: requestId, run: legacyReserve,
  })).rejects.toMatchObject({ code: "BUDGET_REPLAY_COMPLETED" });
  await expect(legacyReserve(fallback, `${requestId}:fallback`)).rejects.toMatchObject({
    code: "BUDGET_REPLAY_COMPLETED",
  });
  expect(paidCall).toHaveBeenCalledOnce();
  const rows = await f.sql`SELECT request_id, state, amount_cents FROM opening_budget_reservations
    WHERE workspace_id=${scope.workspaceId} AND parent_interaction_id=${parentBudget.id}`;
  expect(rows).toHaveLength(2);
  expect(rows.filter(row => row.state !== "released")).toEqual([{
    request_id: `${requestId}:fallback`,
    state: "completed", amount_cents: 1,
  }]);
  await expect(service.replyEphemeral(scope, request)).rejects.toMatchObject({ code: "BUDGET_REPLAY_COMPLETED" });
  expect(paidCall).toHaveBeenCalledOnce();
});

it("does not reactivate the fallback fence after a fallbackStartsFamily release", async () => {
  const { budget } = ledger();
  const { scope } = f;
  const clientKey = randomUUID();
  const parentId = `study-ephemeral:${scope.workspaceId}:${clientKey}`;
  const primaryFailure = new OpeningProviderError("PROVIDER_AUTH", "bad credentials");
  const fallbackCall = vi.fn(async () => { throw primaryFailure; });
  const fallback = model("fallback-terminal", fallbackCall);
  const service = createEphemeralTutorService({
    budget,
    provider: null,
    resolveModel: async () => { throw primaryFailure; },
    resolveFallbackModel: async () => fallback,
    sources: { listOwnedIds: async () => [] }, chunks: { listForSources: async () => [] },
    privacy: { snapshot: async () => ({ epoch: 0, excludedSourceIds: [] }), currentEpoch: async () => 0 },
    config: { maxContextCharacters: 1000, maxOutputTokens: 32, reservedCents: 10, inputCentsPerMillion: 1, outputCentsPerMillion: 1 },
  });
  const request = { text: "Explain", sourceIds: [], history: [], clientKey };

  await expect(service.replyEphemeral(scope, request)).rejects.toMatchObject({ code: "EPHEMERAL_REQUEST_NOT_SENT" });
  expect(fallbackCall).toHaveBeenCalledOnce();
  const before = await f.sql`SELECT request_id, state, release_reason, reserved_amount_cents, model_snapshot
    FROM opening_budget_reservations WHERE workspace_id=${scope.workspaceId} AND parent_interaction_id=${parentId}
    ORDER BY request_id`;
  expect(before).toHaveLength(2);
  expect(before).toEqual(expect.arrayContaining([
    expect.objectContaining({ request_id: `eph:${clientKey}`, state: "released", release_reason: "not_sent", reserved_amount_cents: 0 }),
    expect.objectContaining({ request_id: `eph:${clientKey}:fallback`, state: "released", release_reason: "not_sent", reserved_amount_cents: 10 }),
  ]));

  await expect(service.replyEphemeral(scope, request)).rejects.toMatchObject({ code: "EPHEMERAL_REQUEST_NOT_SENT" });
  expect(fallbackCall).toHaveBeenCalledOnce();
  await expect(f.sql`SELECT request_id, state, release_reason FROM opening_budget_reservations
    WHERE workspace_id=${scope.workspaceId} AND parent_interaction_id=${parentId} ORDER BY request_id`).resolves.toEqual([
    { request_id: `eph:${clientKey}`, state: "released", release_reason: "not_sent" },
    { request_id: `eph:${clientKey}:fallback`, state: "released", release_reason: "not_sent" },
  ]);
});

it("blocks a legacy rollback reader on an active encoded sibling after a workspace collision", async () => {
  const repo = createOpeningBudgetRepository(f.sql, { envCapCents: 100_000 });
  const clientKey = randomUUID();
  const legacy = `eph:${clientKey}`;
  const encoded = `eph-v2:${f.otherScope.workspaceId}:${Buffer.from(clientKey, "utf16le").toString("base64url")}`;
  await f.sql`INSERT INTO opening_budget_reservations
    (id, workspace_id, purpose, amount_cents, reserved_amount_cents, request_id, parent_interaction_id)
    VALUES (${randomUUID()}, ${f.scope.workspaceId}, 'tutor', 10, 10, ${legacy},
      ${`study-ephemeral:${f.scope.workspaceId}:${clientKey}`})`;
  const encodedReservation = await repo.reserve(f.otherScope, {
    purpose: "tutor", amountCents: 10, requestId: legacy,
    parentBudget: { id: `study-ephemeral:${f.otherScope.workspaceId}:${clientKey}` },
    requestFamily: legacy, alternateRequestFamily: encoded,
  });
  expect(encodedReservation.requestId).toBe(encoded);
  await expect(repo.reserve(f.otherScope, {
    purpose: "tutor", amountCents: 10, requestId: `${legacy}:fallback`,
    parentBudget: { id: `study-ephemeral:${f.otherScope.workspaceId}:${clientKey}` }, requestFamily: null,
  })).rejects.toMatchObject({ code: "BUDGET_EXECUTION_CLAIMED", disposition: { reservationId: encodedReservation.id } });
});

it.each(["unknown", "completed", "not_sent"] as const)("keeps the whole operation's %s fallback history after the user removes that route", async outcome => {
  const { budget } = ledger();
  const primaryCall = vi.fn(async () => { throw new OpeningProviderError("PROVIDER_AUTH", "bad credentials"); });
  const fallbackCall = vi.fn(async () => {
    if (outcome !== "completed") throw new OpeningProviderError(outcome === "unknown" ? "PROVIDER_TIMEOUT" : "PROVIDER_AUTH", "controlled fallback");
    return { text: "answered", citedChunkIds: [], candidates: [], requestId: "receipt", inputTokens: 1, outputTokens: 1 };
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
