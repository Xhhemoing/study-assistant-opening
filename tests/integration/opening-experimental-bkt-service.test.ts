import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { nextLearningStep } from "@aistudy/domain";
import { createOpeningExperimentalBktSnapshotRepository } from "../../packages/database/src/repositories/opening-experimental-bkt-snapshot";
import { createOpeningSourceActionsRepository } from "../../packages/database/src/repositories/opening-source-actions";
import { reviseOpeningLearningObservation } from "../../packages/database/src/repositories/opening-observation-revisions";
import { refreshOpeningLearningEligibility } from "../../packages/database/src/repositories/opening-learning-eligibility";
import { createExperimentalBktSnapshotService } from "../../apps/web/src/lib/experimental-bkt-snapshot-service";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { barrier, seedBktService, traceBktSql, type BktServiceFixture } from "./opening-experimental-bkt-service-fixture";

// Self-contained CI input: schema-backed synthetic facts only; no private JSON,
// external model, HTTP, browser, fake rows, SQL mock, or predictor replacement.
let fixture: OpeningFixture;
beforeEach(async () => { fixture = await createOpeningFixture(); });
afterEach(async () => { await fixture?.close(); });

async function assertCompared(f: BktServiceFixture) {
  const snapshot = await f.repository.read(f.scope, f.input);
  expect(snapshot.status, JSON.stringify(snapshot)).toBe("available");
  expect(snapshot.features).toHaveLength(5);
  expect(new Set(snapshot.observationHeads.map(h => h.problemId)).size).toBe(5);
  expect(new Set(snapshot.families.map(h => h.familyId)).size).toBeGreaterThanOrEqual(2);
  expect(snapshot.features.every(h => h.eligibility.verifiedCorrect === "yes"
    && h.eligibility.independentAttempt === "yes")).toBe(true);
  const result = await createExperimentalBktSnapshotService({ host: f.host, repository: f.repository }).readPort({ enabled: true });
  expect(result).toEqual({ comparisonReady: true, reason: "compared", port: {
    status: "compared", ruleDecision: { activityKind: "transfer_check", reasonCode: "independent" },
    experimentalAdvice: { kind: "continue_rule" },
  } });
  return snapshot;
}

describe("card 1 — real PG → repository → service → pinned wrapper → display port", () => {
  it("compares five legal independent canonical items from multiple families without upgrading the authoritative rule", async () => {
    const f = await seedBktService(fixture);
    const migrations = await f.sql`SELECT id,verification_state,checksum FROM schema_migrations ORDER BY id`;
    expect(migrations).toHaveLength(111);
    expect(migrations[0]!.id).toBe("0001_library.sql");
    expect(migrations.at(-1)!.id).toBe("0111_opening_explicit_regrade_requests.sql");
    expect(migrations.every(r => r.verification_state === "verified" && /^[a-f0-9]{64}$/.test(String(r.checksum)))).toBe(true);
    expect(f.heads.every(h => h.observation.verdictSource === "deterministic" && h.observation.outcome === "correct")).toBe(true);
    await assertCompared(f);
  });
  it("default off neither resolves host nor reads PG; prepare remains disabled data, never a reusable comparison grant", async () => {
    const f = await seedBktService(fixture);
    let reads = 0;
    const repository = { read: (...args: Parameters<typeof f.repository.read>) => { reads++; return f.repository.read(...args); } };
    const service = createExperimentalBktSnapshotService({ host: f.host, repository });
    expect(await service.read()).toEqual({ status: "disabled" });
    expect(await service.prepare()).toEqual({ status: "disabled" });
    expect(await service.readPort()).toEqual({ comparisonReady: false, reason: "disabled", port: null });
    expect(f.grants.resolves).toBe(0);
    expect(reads).toBe(0);
    const prepared = await service.prepare({ enabled: true });
    expect(prepared).toMatchObject({ status: "unavailable", comparisonReady: false, reason: "comparison_not_requested",
      preparation: { mode: "read_only", authorization: "host_checked", qualification: { experiment: { enabled: false } } } });
    expect(reads).toBe(1);
    f.grants.compare = false;
    expect(await service.readPort({ enabled: true })).toEqual({ comparisonReady: false, reason: "host_comparison_not_authorized", port: null });
    expect(reads).toBe(1);
  });
});

async function assertInsufficient(f: BktServiceFixture, ids: string[]) {
  const snapshot = await f.repository.read(f.scope, f.context.target);
  expect(snapshot.status, JSON.stringify(snapshot)).toBe("available");
  expect(snapshot.observationHeads.map(h => h.id).sort()).toEqual([...ids].sort());
  expect(await createExperimentalBktSnapshotService({ host: f.host, repository: f.repository }).readPort({ enabled: true }))
    .toEqual({ comparisonReady: false, reason: "insufficient_samples", port: { status: "fallback",
      ruleDecision: { activityKind: "transfer_check", reasonCode: "independent" },
      experimentalAdvice: null, reason: "insufficient_samples" } });
  return snapshot;
}

describe("card 2 — real evidence exclusion and live DI host authorization", () => {
  it("late recorded evidence drops below five; held-out canonical family removes all siblings, never just an ID", async () => {
    const f = await seedBktService(fixture);
    await assertCompared(f);
    const late = f.heads[0]!;
    await f.sql`UPDATE opening_learning_observations SET recorded_at=${f.input.cutoff} WHERE id=${late.observation.id}`;
    const reduced = await assertInsufficient(f, f.heads.slice(1).map(h => h.observation.id));
    expect(reduced.excluded.dual_time_unavailable).toBe(1);
    f.context.target = { ...f.input, excludedProblemIds: [f.heads[2]!.observation.id] };
    const held = await assertInsufficient(f, [f.heads[1]!.observation.id, f.heads[4]!.observation.id]);
    expect(held.excluded.held_out_or_target_family).toBe(2);
    expect(held.families.every(h => h.familyId !== "span:rational-3d")).toBe(true);
  });
  it("real delivered help invalidates independent evidence and service cannot compare", async () => {
    const f = await seedBktService(fixture);
    await assertCompared(f);
    const help = await f.help();
    expect(help.delivered).toBe(true);
    await f.refresh();
    const snapshot = await f.repository.read(f.scope, f.input);
    expect(snapshot).toMatchObject({ status: "not_available", reason: "no_qualified_heads", features: [] });
    expect(Object.values(snapshot.excluded).reduce((sum, n) => sum + n, 0)).toBe(5);
    expect(await createExperimentalBktSnapshotService({ host: f.host, repository: f.repository }).readPort({ enabled: true }))
      .toEqual({ comparisonReady: false, reason: "snapshot:no_qualified_heads", port: null });
    const stored = await f.sql`SELECT delivered,turn_id FROM opening_help_exposures WHERE id=${help.id}`;
    expect(stored).toEqual([{ delivered: true, turn_id: help.turnId }]);
  });
  it("append-only real retraction removes the effective sample and never reuses the old five-head comparison", async () => {
    const f = await seedBktService(fixture);
    await assertCompared(f);
    const root = f.heads[0]!.observation.id;
    const retracted = await reviseOpeningLearningObservation(f.sql, f.scope, { rootObservationId: root,
      revisesObservationId: root, expectedHead: root, revisionKind: "retract", reason: "Withdraw evidence in integration test",
      clientKey: randomUUID() });
    await f.refresh();
    expect(retracted.headObservationId).not.toBe(root);
    await assertInsufficient(f, f.heads.slice(1).map(h => h.observation.id));
  });
  it("real source privacy exclusion blocks a previously successful service comparison", async () => {
    const f = await seedBktService(fixture);
    await assertCompared(f);
    const actions = createOpeningSourceActionsRepository(f.sql), impact = await actions.impact(f.scope, f.sourceId);
    await actions.apply(f.scope, f.sourceId, { action: "exclude", expectedVersion: impact.version,
      expectedMembershipIds: impact.courses.map(c => c.membershipId) },
    { stagingKey: id => `test/${id}/staging`, finalKey: (id, version) => `test/${id}/${version}` }, new Date());
    const service = createExperimentalBktSnapshotService({ host: f.host, repository: f.repository });
    expect(await service.readPort({ enabled: true })).toEqual({ comparisonReady: false,
      reason: "snapshot:canonical_target_family_unavailable", port: null });
    const [privacy] = await f.sql`SELECT privacy_epoch FROM workspaces WHERE id=${f.scope.workspaceId}`;
    expect(Number(privacy!.privacy_epoch)).toBe(1);
  });
  it("real SQL scope changes cannot expose another owner's five eligible heads", async () => {
    const f = await seedBktService(fixture);
    await assertCompared(f);
    for (const scope of [fixture.otherScope, { ...f.scope, ownerUserId: fixture.otherScope.ownerUserId }]) {
      f.context.scope = scope;
      expect(await createExperimentalBktSnapshotService({ host: f.host, repository: f.repository }).readPort({ enabled: true }))
        .toEqual({ comparisonReady: false, reason: "snapshot:snapshot_unavailable", port: null });
    }
  });
  it("a complete host rule containing a real filtered target error conflicts; the stale construction rule must NOT become a port", async () => {
    const f = await seedBktService(fixture);
    await assertCompared(f);
    const error = await f.targetError();
    expect(error).toMatchObject({ verdictSource: "deterministic", outcome: "incorrect" });
    await f.sql.begin(tx => refreshOpeningLearningEligibility(tx, f.scope, [error.id]));
    await f.refresh();
    // Host DI projection of REAL stored qualification, not an invented head.
    // Complete/current evidence can extend beyond the experimental cutoff.
    const [stored] = await f.sql`SELECT o.id,o.problem_id,o.item_version_id,o.requirement_key,o.skill_label,o.submitted_at,
      o.assistance,p.independent_attempt,p.verified_correct,p.usable_for_current_version
      FROM opening_learning_observations o JOIN opening_learning_eligibility p ON p.head_observation_id=o.id
        AND p.workspace_id=o.workspace_id AND p.owner_user_id=o.owner_user_id WHERE o.id=${error.id}`;
    expect(stored).toMatchObject({ assistance: "independent", independent_attempt: "yes", verified_correct: "no", usable_for_current_version: "yes" });
    const fullRule = nextLearningStep({ ...f.context.ruleInput!, observations: [{ id: String(stored!.id),
      problemId: String(stored!.problem_id), itemVersionId: String(stored!.item_version_id),
      requirementKey: String(stored!.requirement_key), skillLabel: String(stored!.skill_label),
      attemptedAt: new Date(stored!.submitted_at as Date).toISOString(), assistance: stored!.assistance,
      independentAttempt: stored!.independent_attempt, verifiedCorrect: stored!.verified_correct,
      usableForCurrentVersion: stored!.usable_for_current_version }] });
    expect(fullRule).toEqual({ activityKind: "targeted_explain", reasonCode: "verified_incorrect", focusObservationId: error.id });
    const subset = await f.repository.read(f.scope, f.input);
    expect(subset.features).toHaveLength(5);
    expect(subset.observationHeads.some(h => h.id === error.id)).toBe(false);
    const stale = f.context.ruleDecision;
    f.context.ruleDecision = fullRule;
    expect(await createExperimentalBktSnapshotService({ host: f.host, repository: f.repository, ruleDecision: stale }).readPort({ enabled: true }))
      .toEqual({ comparisonReady: false, reason: "host_rule_context_conflict", port: null });
  });
  it.each(["current", "prepare", "compare"] as const)("DI %s revocation before SQL or after a real SQL read suppresses comparison", async permission => {
    const f = await seedBktService(fixture);
    await assertCompared(f);
    let reads = 0;
    const repository = { async read(...args: Parameters<typeof f.repository.read>) {
      reads++;
      const snapshot = await f.repository.read(...args);
      f.grants[permission] = false;
      return snapshot;
    } };
    const reason = permission === "current" ? "host_authorization_revoked"
      : permission === "prepare" ? "host_prepare_not_authorized" : "host_comparison_not_authorized";
    const service = createExperimentalBktSnapshotService({ host: f.host, repository });
    f.grants[permission] = false;
    expect(await service.readPort({ enabled: true })).toEqual({ comparisonReady: false, reason, port: null });
    expect(reads).toBe(0);
    f.grants[permission] = true;
    expect(await service.readPort({ enabled: true })).toEqual({ comparisonReady: false, reason, port: null });
    expect(reads).toBe(1);
  });
});

describe("card 3 — cancellation/errors across actual PG MVCC windows", () => {
  it.each(["cancel", "abort", "newer_read"] as const)("%s during real SQL never publishes a superseded comparison", async kind => {
    const f = await seedBktService(fixture);
    await assertCompared(f);
    const entered = barrier(), resume = barrier();
    const trace = traceBktSql(f.sql, { afterContext: async () => { entered.release(); await resume.promise; } });
    const service = createExperimentalBktSnapshotService({ host: f.host,
      repository: createOpeningExperimentalBktSnapshotRepository(trace.sql) });
    const controller = new AbortController(), pending = service.readPort({ enabled: true, signal: controller.signal });
    try {
      await entered.promise;
      if (kind === "cancel") service.cancel();
      else if (kind === "abort") controller.abort();
      else expect(await service.readPort()).toEqual({ comparisonReady: false, reason: "disabled", port: null });
    } finally { resume.release(); }
    expect(await pending).toEqual({ comparisonReady: false, reason: "cancelled", port: null });
    expect(trace.transactions).toHaveLength(1);
    expect(trace.transactions[0]!.order).toEqual(["context", "target", "heads"]);
  });
  it("two overlapping enabled reads publish only the newer real SQL comparison", async () => {
    const f = await seedBktService(fixture), entered = barrier(), resume = barrier();
    let calls = 0;
    const trace = traceBktSql(f.sql, { afterContext: async () => {
      if (++calls === 1) { entered.release(); await resume.promise; }
    } });
    const service = createExperimentalBktSnapshotService({ host: f.host,
      repository: createOpeningExperimentalBktSnapshotRepository(trace.sql) });
    const older = service.readPort({ enabled: true });
    try {
      await entered.promise;
      expect(await service.readPort({ enabled: true })).toMatchObject({ comparisonReady: true, reason: "compared", port: { status: "compared" } });
    } finally { resume.release(); }
    expect(await older).toEqual({ comparisonReady: false, reason: "cancelled", port: null });
    expect(trace.transactions).toHaveLength(2);
    expect(trace.transactions.every(t => new Set(t.tokens).size === 1)).toBe(true);
  });
  it.each(["current", "compare"] as const)("%s revoked inside real SQL discards qualified data", async permission => {
    const f = await seedBktService(fixture), entered = barrier(), resume = barrier();
    const trace = traceBktSql(f.sql, { afterContext: async () => { entered.release(); await resume.promise; } });
    const service = createExperimentalBktSnapshotService({ host: f.host,
      repository: createOpeningExperimentalBktSnapshotRepository(trace.sql) });
    const pending = service.readPort({ enabled: true });
    try { await entered.promise; f.grants[permission] = false; }
    finally { resume.release(); }
    expect(await pending).toEqual({ comparisonReady: false,
      reason: permission === "current" ? "host_authorization_revoked" : "host_comparison_not_authorized", port: null });
    expect(trace.transactions[0]!.order).toEqual(["context", "target", "heads"]);
  });
  it("real PG statement error propagates by identity without fallback, retry or success", async () => {
    const f = await seedBktService(fixture);
    let failure: unknown;
    const trace = traceBktSql(f.sql, { afterContext: async tx => {
      try { await tx`SELECT 1/0`; }
      catch (error) { failure = error; throw error; }
    } });
    const service = createExperimentalBktSnapshotService({ host: f.host,
      repository: createOpeningExperimentalBktSnapshotRepository(trace.sql) });
    await service.readPort({ enabled: true }).then(() => { throw new Error("unexpected success"); }, error => {
      expect(error).toBe(failure);
      expect(error).toMatchObject({ code: "22012" });
    });
    expect(trace.transactions).toHaveLength(1);
    expect(trace.transactions[0]!.order).toEqual(["context"]);
    await assertCompared(f);
  });
  it("readPort compares from its one old MVCC window, then rejects a committed source-version change on fresh IO", async () => {
    const f = await seedBktService(fixture), writer = postgres(process.env.OPENING_TEST_DATABASE_URL!, { max: 1 });
    const trace = traceBktSql(f.sql, { afterContext: async () => {
      await writer`UPDATE opening_sources SET version=version+1 WHERE id=${f.sourceId}`;
    } });
    try {
      const real = createOpeningExperimentalBktSnapshotRepository(trace.sql);
      let actual: Awaited<ReturnType<typeof real.read>> | undefined;
      const service = createExperimentalBktSnapshotService({ host: f.host, repository: {
        async read(...args: Parameters<typeof real.read>) { actual = await real.read(...args); return actual; },
      } });
      expect(await service.readPort({ enabled: true })).toMatchObject({ comparisonReady: true, reason: "compared",
        port: { status: "compared", experimentalAdvice: { kind: "continue_rule" } } });
      expect(actual?.features).toHaveLength(5);
      const t = trace.transactions[0]!, asOf = new Date(t.context.data_as_of as Date).toISOString();
      expect(actual?.stateVersion).toBe(`bkt-read:${t.context.snapshot_token}:${t.context.revision}:${asOf}`);
      expect(actual?.dataAsOf).toBe(asOf);
      expect(t.order).toEqual(["context", "target", "heads"]);
      expect(new Set(t.tokens).size).toBe(1);
      expect(await createExperimentalBktSnapshotService({ host: f.host, repository: f.repository }).readPort({ enabled: true }))
        .toEqual({ comparisonReady: false, reason: "snapshot:canonical_target_family_unavailable", port: null });
    } finally { await writer.end({ timeout: 5 }); }
  });
  it("same prepare read binds dataAsOf/stateVersion/heads; readonly PG rejects writes; concurrent privacy appears on NEXT read", async () => {
    const f = await seedBktService(fixture);
    await assertCompared(f);
    const writer = postgres(process.env.OPENING_TEST_DATABASE_URL!, { max: 1 });
    let readonlyError: unknown;
    const trace = traceBktSql(f.sql, { afterContext: async tx => {
      try { await tx.savepoint(async save => { await save`UPDATE workspaces SET privacy_epoch=privacy_epoch WHERE id=${f.scope.workspaceId}`; }); }
      catch (error) { readonlyError = error; }
      const actions = createOpeningSourceActionsRepository(writer), impact = await actions.impact(f.scope, f.sourceId);
      await actions.apply(f.scope, f.sourceId, { action: "exclude", expectedVersion: impact.version,
        expectedMembershipIds: impact.courses.map(c => c.membershipId) },
      { stagingKey: id => `test/${id}/staging`, finalKey: (id, v) => `test/${id}/${v}` }, new Date());
    } });
    try {
      const service = createExperimentalBktSnapshotService({ host: f.host,
        repository: createOpeningExperimentalBktSnapshotRepository(trace.sql) });
      const prepared = await service.prepare({ enabled: true });
      expect(readonlyError).toMatchObject({ code: "25006" });
      expect(prepared).toMatchObject({ reason: "comparison_not_requested", comparisonReady: false,
        preparation: { snapshot: { status: "available" }, qualification: { experiment: { enabled: false } } } });
      if (prepared.status !== "unavailable" || !prepared.preparation) throw new Error("missing real preparation");
      const { snapshot, qualification } = prepared.preparation, t = trace.transactions[0]!;
      const asOf = new Date(t.context.data_as_of as Date).toISOString();
      expect(t.mode).toBe("isolation level repeatable read read only");
      expect(t.settings).toMatchObject({ readonly: "on", isolation: "repeatable read" });
      expect(t.order).toEqual(["context", "target", "heads"]);
      expect(t.tokens).toHaveLength(4);
      expect(new Set(t.tokens).size).toBe(1);
      expect(snapshot.dataAsOf).toBe(asOf);
      expect(snapshot.stateVersion).toBe(`bkt-read:${t.context.snapshot_token}:${t.context.revision}:${asOf}`);
      expect(qualification.dataAsOf).toBe(snapshot.dataAsOf);
      expect(qualification.stateVersion).toBe(snapshot.stateVersion);
      expect(qualification.observationHeads).toEqual(snapshot.observationHeads);
      expect(qualification.experiment.features).toEqual(snapshot.features);
      expect(snapshot.features).toHaveLength(5);
      // No historical replay or reusable preparation receipt; fresh read required.
      expect(await createExperimentalBktSnapshotService({ host: f.host, repository: f.repository }).readPort({ enabled: true }))
        .toEqual({ comparisonReady: false, reason: "snapshot:canonical_target_family_unavailable", port: null });
      const next = await f.repository.read(f.scope, f.input);
      expect(next.stateVersion).not.toBe(snapshot.stateVersion);
      expect(next).toMatchObject({ status: "not_available", features: [] });
      console.info("BKT_SERVICE_MVCC", JSON.stringify({ during: snapshot.features.length, next: next.reason,
        readonly: t.settings.readonly, snapshots: t.tokens, sameReadIdentity: true, historicalReplay: false }));
    } finally { await writer.end({ timeout: 5 }); }
  });
});
