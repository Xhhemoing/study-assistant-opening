import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as wrapperModule from "../../packages/domain/src/opening/adaptive/experimental-bkt-advice";
import * as portModule from "../../apps/web/src/features/opening/teaching/experimental-learning-advice-port";
import { createExperimentalBktSnapshotService } from "../../apps/web/src/lib/experimental-bkt-snapshot-service";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { seedFiveActivation, type FiveActivationFixture } from "./opening-experimental-bkt-five-activation-fixture";

let fixture: OpeningFixture;
beforeEach(async () => { fixture = await createOpeningFixture(); });
afterEach(async () => { vi.restoreAllMocks(); await fixture?.close(); });
const authoritativeRule = { activityKind: "transfer_check", reasonCode: "independent" };
const compared = (kind: "continue_rule" | "supported_practice") => ({ comparisonReady: true, reason: "compared", port: {
  status: "compared", ruleDecision: authoritativeRule, experimentalAdvice: { kind },
} });
const insufficient = { comparisonReady: false, reason: "insufficient_samples", port: { status: "fallback",
  ruleDecision: authoritativeRule, experimentalAdvice: null, reason: "insufficient_samples" } };

function observe(f: FiveActivationFixture) {
  // These spies call through without replacement: PG, real fixed wrapper,
  // predictor and actual port all execute. A wrapper call is the invocation of
  // the service-owned provideExperimentalResult callback, not a paid provider.
  const wrapper = vi.spyOn(wrapperModule, "nextLearningStepWithExperimentalBkt");
  const port = vi.spyOn(portModule, "createExperimentalLearningAdvicePort");
  const read = vi.spyOn(f.repository, "read");
  const service = createExperimentalBktSnapshotService({ host: f.host, repository: f.repository });
  return { wrapper, port, read, service };
}
function wrapperValue(probe: ReturnType<typeof observe>) {
  expect(probe.port).toHaveBeenCalledTimes(1);
  expect(probe.wrapper).toHaveBeenCalledTimes(1);
  expect(probe.port.mock.calls[0]![0].experimentEnabled).toBe(true);
  expect(probe.port.mock.calls[0]![0].provideExperimentalResult).toBeTypeOf("function");
  expect(probe.wrapper.mock.calls[0]![1]?.enabled).toBe(true);
  expect(probe.wrapper.mock.results[0]!.type).toBe("return");
  return probe.wrapper.mock.results[0]!.value as ReturnType<typeof wrapperModule.nextLearningStepWithExperimentalBkt>;
}
async function qualified(f: FiveActivationFixture, count: number) {
  expect(f.heads.every(h => h.observation.verdictSource === "deterministic")).toBe(true);
  const persisted = await f.sql`SELECT verified_correct,independent_attempt,usable_for_current_version,reason_codes
    FROM opening_learning_eligibility WHERE workspace_id=${f.scope.workspaceId} AND owner_user_id=${f.scope.ownerUserId}`;
  expect(persisted).toHaveLength(f.heads.length);
  expect(persisted.every(row => row.independent_attempt === "yes" && row.usable_for_current_version === "yes"
    && ["yes", "no"].includes(String(row.verified_correct))
    && row.reason_codes.includes(row.verified_correct === "yes" ? "deterministic_correct" : "deterministic_incorrect"))).toBe(true);
  const snapshot = await f.repository.read(f.scope, f.input);
  expect(snapshot.status, JSON.stringify(snapshot)).toBe("available");
  expect(snapshot.features).toHaveLength(count);
  expect(new Set(snapshot.observationHeads.map(row => row.problemId)).size).toBe(count);
  return snapshot;
}

describe("additional real PG five-problem advice activation through fixed wrapper and display port", () => {
  it("default off and prepare cannot call the service-owned provider or activate the port", async () => {
    const f = await seedFiveActivation(fixture), p = observe(f);
    expect(await p.service.readPort()).toEqual({ comparisonReady: false, reason: "disabled", port: null });
    expect(f.grants.resolves).toBe(0);
    expect(p.read).not.toHaveBeenCalled();
    expect(p.port).not.toHaveBeenCalled();
    expect(p.wrapper).not.toHaveBeenCalled();
    const prepared = await p.service.prepare({ enabled: true });
    expect(prepared).toMatchObject({ reason: "comparison_not_requested", comparisonReady: false,
      preparation: { qualification: { experiment: { enabled: false } } } });
    expect(p.read).toHaveBeenCalledTimes(1);
    expect(p.port).not.toHaveBeenCalled();
    expect(p.wrapper).not.toHaveBeenCalled();
  });

  it.each(["current", "prepare", "compare"] as const)("host %s denial makes zero PG/provider/port calls even with five real samples", async permission => {
    const f = await seedFiveActivation(fixture), p = observe(f);
    f.grants[permission] = false;
    const reason = permission === "current" ? "host_authorization_revoked"
      : permission === "prepare" ? "host_prepare_not_authorized" : "host_comparison_not_authorized";
    expect(await p.service.readPort({ enabled: true })).toEqual({ comparisonReady: false, reason, port: null });
    expect(f.grants.resolves).toBe(1);
    expect(p.read).not.toHaveBeenCalled();
    expect(p.port).not.toHaveBeenCalled();
    expect(p.wrapper).not.toHaveBeenCalled();
  });

  it("four real qualified problems invoke the enabled provider once but fall back to the authoritative rule", async () => {
    const f = await seedFiveActivation(fixture, { count: 4 });
    await qualified(f, 4);
    const p = observe(f);
    expect(await p.service.readPort({ enabled: true })).toEqual(insufficient);
    expect(p.read).toHaveBeenCalledTimes(1);
    expect(wrapperValue(p)).toMatchObject({ calibrated: false, experimentalAdvice: null,
      comparison: { status: "fallback", reason: "insufficient_samples", sampleCount: 4, differsFromRule: false } });
  });

  it.each([5, 6] as const)("%i real distinct problems activate the fixed experiment with fewer than five families", async count => {
    const f = await seedFiveActivation(fixture, { count });
    const snapshot = await qualified(f, count);
    const familyCount = new Set(snapshot.families.map(row => row.familyId)).size;
    expect(familyCount).toBe(count === 5 ? 3 : 4);
    expect(familyCount).toBeLessThan(5);
    const p = observe(f);
    expect(await p.service.readPort({ enabled: true })).toEqual(compared("continue_rule"));
    expect(p.read).toHaveBeenCalledTimes(1);
    const result = wrapperValue(p);
    expect(result).toMatchObject({ calibrated: false, comparison: { status: "compared", sampleCount: count },
      experimentalAdvice: { kind: "continue_rule", success: count, failure: 0 } });
    expect(result.experimentalAdvice!.evidenceObservationIds.slice().sort()).toEqual(snapshot.observationHeads.map(row => row.id).sort());
    expect(result.ruleDecision).toEqual(f.context.ruleDecision);
  });

  it("a second source with the same canonical problem cannot inflate five samples into six", async () => {
    const f = await seedFiveActivation(fixture);
    await f.duplicateCanonicalProblem();
    expect(new Set(f.heads.map(h => h.attempt.problemId)).size).toBe(6);
    expect(f.heads[0]!.attempt.spanExercise!.id).toBe(f.heads[5]!.attempt.spanExercise!.id);
    // The real qualifier also recognizes prior feedback on the repeated item;
    // never label this sixth attempt independent just to satisfy the fixture.
    const qualification = await f.sql`SELECT independent_attempt,verified_correct,reason_codes
      FROM opening_learning_eligibility WHERE workspace_id=${f.scope.workspaceId} AND owner_user_id=${f.scope.ownerUserId}`;
    expect(qualification).toHaveLength(6);
    expect(qualification.filter(row => row.independent_attempt === "yes")).toHaveLength(5);
    expect(qualification.filter(row => row.independent_attempt === "no")).toEqual([
      expect.objectContaining({ verified_correct: "yes", reason_codes: expect.arrayContaining(["prior_evaluation_feedback"]) }),
    ]);
    const snapshot = await f.repository.read(f.scope, f.input);
    expect(snapshot.status).toBe("available");
    expect(snapshot.features).toHaveLength(4);
    // Real SQL has_conflicting_history poisons both canonical copies before
    // projection could count either as another distinct problem/family.
    expect(snapshot.excluded.identity_conflict).toBe(2);
    expect(snapshot.features.some(row => [f.heads[0]!.observation.id, f.heads[5]!.observation.id].includes(row.observationId))).toBe(false);
    const p = observe(f);
    expect(await p.service.readPort({ enabled: true })).toEqual(insufficient);
    expect(wrapperValue(p).comparison).toMatchObject({ sampleCount: 4, reason: "insufficient_samples" });
  });

  it("conflicting persisted family metadata removes that problem instead of inventing another family/sample", async () => {
    const f = await seedFiveActivation(fixture);
    // Synthetic malformed DB boundary input, not a fabricated qualification:
    // canonical problem q08 belongs to dependent-generators, never geometry-plane.
    await f.sql`UPDATE opening_learning_item_versions
      SET evaluation_spec=jsonb_set(evaluation_spec,'{familyId}','"span:geometry-plane"'::jsonb)
      WHERE id=${f.heads[0]!.attempt.itemVersionId}`;
    await f.refresh();
    const snapshot = await f.repository.read(f.scope, f.input);
    expect(snapshot.status).toBe("available");
    expect(snapshot.features).toHaveLength(4);
    expect(snapshot.excluded.canonical_family_unavailable).toBe(1);
    expect(snapshot.families.some(row => row.familyId === "span:geometry-plane")).toBe(false);
    const p = observe(f);
    expect(await p.service.readPort({ enabled: true })).toEqual(insufficient);
    expect(wrapperValue(p).comparison.sampleCount).toBe(4);
  });

  it("low next-correct probability offers support while preserving the rule and exposing no probability/private fields", async () => {
    // Four older deterministic errors followed by a current correct answer:
    // current rule remains independent; the real BKT can offer extra support.
    const f = await seedFiveActivation(fixture, { olderErrors: true });
    const snapshot = await qualified(f, 5);
    expect(f.heads.map(h => h.observation.outcome)).toEqual(["incorrect", "incorrect", "incorrect", "incorrect", "correct"]);
    const p = observe(f), output = await p.service.readPort({ enabled: true });
    expect(output).toEqual(compared("supported_practice"));
    const result = wrapperValue(p);
    expect(result).toMatchObject({ calibrated: false, ruleDecision: f.context.ruleDecision,
      comparison: { status: "compared", sampleCount: 5, differsFromRule: true },
      experimentalAdvice: { success: 1, failure: 4, kind: "supported_practice", activityKind: "reduced_help_practice" } });
    expect(result.experimentalAdvice!.probability).toBeLessThan(0.6);
    const serialized = JSON.stringify(output);
    for (const privateValue of [f.scope.workspaceId, f.scope.ownerUserId, f.courseId, f.sourceId,
      f.target.problemId!, f.target.itemVersionId!, snapshot.stateVersion!, snapshot.dataAsOf!,
      ...f.heads.flatMap(h => [h.observation.id, h.attempt.id, h.attempt.problemId!, h.attempt.itemVersionId!])]) {
      expect(serialized).not.toContain(privateValue);
    }
    expect(serialized).not.toMatch(/probability|mastery|answer|sourceIds|features|evidence|stateVersion|dataAsOf|retention|transferUsable/);
    const prepared = await p.service.prepare({ enabled: true });
    if (prepared.status !== "unavailable" || !prepared.preparation) throw new Error("missing real preparation");
    const { qualification } = prepared.preparation;
    expect(qualification.experiment.enabled).toBe(false);
    expect(qualification.experiment.features.every(row => row.sourceIds.length === 0
      && Object.keys(row.sourceVersions).length === 0 && row.transfer.usable === "unknown"
      && row.retention.protocolId === null)).toBe(true);
    expect(p.wrapper).toHaveBeenCalledTimes(1);
    console.info("FIVE_ACTIVATION", JSON.stringify({ problems: 5, families: new Set(snapshot.families.map(row => row.familyId)).size,
      sampleCount: result.comparison.sampleCount, providerCalls: p.wrapper.mock.calls.length,
      nextCorrectProbability: result.experimentalAdvice!.probability, calibrated: result.calibrated, port: output,
      masteryClaim: false, concreteAuthOrBrowser: false }));
  });
});
