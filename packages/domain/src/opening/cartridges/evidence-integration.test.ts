import { describe, expect, it } from "vitest";
import {
  applyCartridgeEvidenceGate,
  evaluateCartridgeEvidenceEligibility,
  evaluateEvidenceEligibility,
  type CartridgeEvidenceInput,
} from "../evidence-eligibility";
import { context, observation } from "../evidence-eligibility-fixtures";
import { assembleLearnerState } from "../learner-state";
import { courseEvidence, learningObservation, qualifiedInput } from "../learning-summary-fixtures";
import { evaluateProbeWithSpec } from "./capability-helpers";
import { qualifyCartridgeEmission, type CartridgeObservationEmission } from "./evidence-gate";
import { createCartridgeRegistry } from "./registry";
import { createStackFeasibilityProbe, stack408Cartridge, toStack408Emission } from "./stack-408-v1";

const TRACE_PROBE = "408.stack.trace.interleaved-underflow.v1";
const CORRECT = { outputs: "2,3,1,UNDERFLOW", finalTop: -1 };
const FIFO = { outputs: "1,2,3,UNDERFLOW", finalTop: -1 };

const degenerate = createStackFeasibilityProbe("408.stack.degenerate", { pushOrder: [1, 2, 3], candidatePops: [3, 2, 1] }, "判断");
const practiceOnly = { ...stack408Cartridge, manifest: { ...stack408Cartridge.manifest, id: "408.stack.practice", level: "L3_MATERIAL_REACTIVE" as const } };
const lenient = { ...stack408Cartridge, manifest: { ...stack408Cartridge.manifest, id: "408.stack.lenient" },
  getProbe: (id: string) => id === degenerate.probeId ? degenerate : stack408Cartridge.getProbe(id),
  evaluateProbeResponse: (id: string, response: unknown) => id === degenerate.probeId
    ? evaluateProbeWithSpec(degenerate, response) : stack408Cartridge.evaluateProbeResponse(id, response) };
const registry = createCartridgeRegistry([stack408Cartridge, practiceOnly, lenient]);

const stackObservation = { ...observation, requirementKey: "408.ds.stack.lifo-trace" };
const emit = (overrides: Partial<CartridgeObservationEmission> = {}) => ({ ...toStack408Emission(TRACE_PROBE, CORRECT), ...overrides });

describe("qualifyCartridgeEmission", () => {
  it("qualifies an L4 emission from a verified probe after re-deriving its outcome", () => {
    const result = qualifyCartridgeEmission(registry, emit(), { outcome: "correct", requirementKey: "408.ds.stack.lifo-trace" });
    expect(result).toMatchObject({ qualified: true, level: "L4_EVIDENCE", reasonCodes: ["cartridge_evidence_qualified"],
      evaluation: { outcome: "correct", diagnosis: "correct_model" }, distinguishability: { distinguishable: true } });
  });

  it("qualifies a deterministic misconception diagnosis as formal incorrect evidence", () => {
    expect(qualifyCartridgeEmission(registry, emit({ response: FIFO }), { outcome: "incorrect" })).toMatchObject({
      qualified: true, evaluation: { outcome: "incorrect", matchedHypothesisId: "H_FIFO_QUEUE_CONFUSION" } });
  });

  it.each([
    ["unregistered cartridge", emit({ cartridgeId: "408.queue.v1" }), {}, "cartridge_unregistered"],
    ["version drift", emit({ cartridgeVersion: "0.9.0" }), {}, "cartridge_version_mismatch"],
    ["L3 cartridge", emit({ cartridgeId: "408.stack.practice" }), {}, "cartridge_level_below_evidence"],
    ["unknown probe", emit({ probeId: "missing" }), {}, "cartridge_probe_unknown"],
    ["degenerate probe", emit({ cartridgeId: "408.stack.lenient", probeId: degenerate.probeId,
      response: { verdict: "feasible" } }), {}, "cartridge_probe_not_distinguishable"],
    ["requirement mismatch", emit(), { requirementKey: "requirement-1" }, "cartridge_probe_requirement_mismatch"],
    ["malformed response", emit({ response: { outputs: "?", finalTop: -1 } }), {}, "cartridge_response_invalid"],
    ["claimed outcome conflict", emit({ response: FIFO }), { outcome: "correct" }, "cartridge_outcome_conflict"],
  ] as const)("withholds %s", (_name, emission, facts, code) => {
    const result = qualifyCartridgeEmission(registry, emission, facts);
    expect(result.qualified).toBe(false);
    expect(result.reasonCodes).toEqual([code]);
  });

  it("rejects a cartridge whose evaluateProbeResponse scores against a different probe or spoofs the verdict", () => {
    const pointerProbeId = "408.stack.pointer.pre-increment.v1";
    const spoofingCartridge = {
      ...stack408Cartridge,
      manifest: { ...stack408Cartridge.manifest, id: "408.stack.spoof" },
      evaluateProbeResponse: () => stack408Cartridge.evaluateProbeResponse(pointerProbeId, { outputs: ["OVERFLOW", 9], finalTop: 1 }),
    };
    const forgedOutcomeCartridge = {
      ...stack408Cartridge,
      manifest: { ...stack408Cartridge.manifest, id: "408.stack.forged" },
      evaluateProbeResponse: (probeId: string) => ({
        probeId,
        requirementKey: "408.ds.stack.lifo-trace",
        outcome: "correct" as const,
        diagnosis: "correct_model" as const,
        matchedHypothesisId: null,
        observableKey: JSON.stringify(["trace", ["2", "3", "1", "UNDERFLOW"], -1]),
      }),
    };
    const localRegistry = createCartridgeRegistry([spoofingCartridge, forgedOutcomeCartridge]);

    const crossProbe = qualifyCartridgeEmission(
      localRegistry,
      emit({ cartridgeId: "408.stack.spoof", response: CORRECT }),
      { outcome: "correct" },
    );
    expect(crossProbe.qualified).toBe(false);
    expect(crossProbe.reasonCodes).toEqual(["cartridge_evaluation_mismatch"]);

    // Raw response is FIFO (incorrect), yet the cartridge returns "correct" with the correct observableKey.
    const forged = qualifyCartridgeEmission(
      localRegistry,
      emit({ cartridgeId: "408.stack.forged", response: FIFO }),
      { outcome: "correct" },
    );
    expect(forged.qualified).toBe(false);
    expect(forged.reasonCodes).toEqual(["cartridge_evaluation_mismatch"]);
  });

  it("rejects when getProbe returns a probe with a mismatched probeId", () => {
    const pointerProbe = stack408Cartridge.getProbe("408.stack.pointer.pre-increment.v1")!;
    const mismatchedLookup = {
      ...stack408Cartridge,
      manifest: { ...stack408Cartridge.manifest, id: "408.stack.mismatch-id" },
      getProbe: (id: string) => id === "spoofed-probe-id" ? pointerProbe : stack408Cartridge.getProbe(id),
    };
    const localRegistry = createCartridgeRegistry([mismatchedLookup]);
    const result = qualifyCartridgeEmission(
      localRegistry,
      emit({ cartridgeId: "408.stack.mismatch-id", probeId: "spoofed-probe-id", response: { outputs: ["OVERFLOW", 9], finalTop: 1 } }),
    );
    expect(result.qualified).toBe(false);
    expect(result.reasonCodes).toEqual(["cartridge_probe_identity_mismatch"]);
  });

  it("catches exceptions from getProbe, observableKey, and evaluateProbeResponse cleanly", () => {
    let shouldThrowLookup = false;
    const throwingLookup = {
      ...stack408Cartridge,
      manifest: { ...stack408Cartridge.manifest, id: "408.stack.throw-lookup" },
      getProbe: (id: string) => {
        if (shouldThrowLookup) throw new Error("getProbe crash");
        return stack408Cartridge.getProbe(id);
      },
    };
    const throwingEval = {
      ...stack408Cartridge,
      manifest: { ...stack408Cartridge.manifest, id: "408.stack.throw-eval" },
      evaluateProbeResponse: () => { throw new Error("evaluateProbeResponse crash"); },
    };
    const baseProbe = stack408Cartridge.getProbe(TRACE_PROBE)!;
    const throwingEncoderProbe = {
      ...baseProbe,
      observableKey: (obs: unknown) => {
        const record = obs as { outputs?: string[] };
        if (record.outputs?.[0] === "99") throw new Error("encode crash");
        if (record.outputs?.[0] === "98") return "   ";
        if (record.outputs?.[0] === "97") return null as unknown as string;
        return baseProbe.observableKey(obs);
      },
    };
    const throwingEncoderCartridge = {
      ...stack408Cartridge,
      manifest: { ...stack408Cartridge.manifest, id: "408.stack.throw-encode" },
      listProbes: () => [throwingEncoderProbe],
      getProbe: (id: string) => id === TRACE_PROBE ? throwingEncoderProbe : null,
      evaluateProbeResponse: (id: string, response: unknown) =>
        id === TRACE_PROBE ? evaluateProbeWithSpec(throwingEncoderProbe, response) : stack408Cartridge.evaluateProbeResponse(id, response),
    };
    const localRegistry = createCartridgeRegistry([throwingLookup, throwingEval, throwingEncoderCartridge]);

    shouldThrowLookup = true;
    const lookupRes = qualifyCartridgeEmission(localRegistry, emit({ cartridgeId: "408.stack.throw-lookup" }));
    expect(lookupRes.qualified).toBe(false);
    expect(lookupRes.reasonCodes).toEqual(["cartridge_probe_lookup_failed"]);

    const evalRes = qualifyCartridgeEmission(localRegistry, emit({ cartridgeId: "408.stack.throw-eval" }));
    expect(evalRes.qualified).toBe(false);
    expect(evalRes.reasonCodes).toEqual(["cartridge_evaluation_failed"]);

    for (const badResponse of [{ outputs: "99", finalTop: -1 }, { outputs: "98", finalTop: -1 }, { outputs: "97", finalTop: -1 }]) {
      const encodeRes = qualifyCartridgeEmission(
        localRegistry,
        emit({ cartridgeId: "408.stack.throw-encode", response: badResponse }),
      );
      expect(encodeRes.qualified).toBe(false);
      expect(encodeRes.reasonCodes).toEqual(["cartridge_evaluation_failed"]);
    }
  });

  it("rejects when a stateful probe drifts between verification snapshot and cartridge evaluation", () => {
    const baseProbe = stack408Cartridge.getProbe(TRACE_PROBE)!;
    let predictCount = 0;
    const driftingProbe = {
      ...baseProbe,
      correctModel: {
        ...baseProbe.correctModel,
        predict: (input: unknown) => {
          predictCount += 1;
          // Passes registration (calls 1-2) and gate snapshot (calls 3-4), then drifts on cartridge evaluateProbeResponse (calls 5-6).
          if (predictCount <= 4) return baseProbe.correctModel.predict(input);
          return { outputs: ["999"], finalTop: 0 };
        },
      },
    };
    const driftingCartridge = {
      ...stack408Cartridge,
      manifest: { ...stack408Cartridge.manifest, id: "408.stack.drift" },
      listProbes: () => [driftingProbe],
      getProbe: (id: string) => id === TRACE_PROBE ? driftingProbe : null,
      evaluateProbeResponse: (id: string, response: unknown) =>
        id === TRACE_PROBE ? evaluateProbeWithSpec(driftingProbe, response) : stack408Cartridge.evaluateProbeResponse(id, response),
    };
    const localRegistry = createCartridgeRegistry([driftingCartridge]);
    const result = qualifyCartridgeEmission(localRegistry, emit({ cartridgeId: "408.stack.drift", response: CORRECT }));
    expect(result.qualified).toBe(false);
    expect(result.reasonCodes).toEqual(["cartridge_evaluation_mismatch"]);
  });
});

describe("applyCartridgeEvidenceGate", () => {
  const base = evaluateEvidenceEligibility(stackObservation, context);

  it("passes through without an emission or with a qualified one", () => {
    expect(applyCartridgeEvidenceGate(base, null)).toBe(base);
    expect(applyCartridgeEvidenceGate(base, qualifyCartridgeEmission(registry, emit()))).toBe(base);
  });

  it("only withholds: correctness and delayed use become unknown, never upgraded", () => {
    const withheld = applyCartridgeEvidenceGate(base, qualifyCartridgeEmission(registry, emit({ cartridgeId: "408.stack.practice" })));
    expect(withheld).toMatchObject({ independentAttempt: "yes", verifiedCorrect: "unknown", usableForCurrentVersion: "yes",
      usableForDelayedCheck: "unknown", policyVersion: base.policyVersion });
    expect(withheld.reasonCodes).toEqual([...base.reasonCodes, "verification_source_untrusted"].sort());
    const ineligible = { ...base, usableForDelayedCheck: "no" as const };
    expect(applyCartridgeEvidenceGate(ineligible, qualifyCartridgeEmission(registry, emit({ cartridgeId: "x" }))).usableForDelayedCheck).toBe("no");
  });

  it("evaluateCartridgeEvidenceEligibility composes both steps", () => {
    expect(evaluateCartridgeEvidenceEligibility(stackObservation, context)).toEqual({ eligibility: base, qualification: null });
    const gated = evaluateCartridgeEvidenceEligibility(stackObservation, context, { registry, emission: emit({ response: FIFO }) });
    expect(gated.qualification?.reasonCodes).toEqual(["cartridge_outcome_conflict"]);
    expect(gated.eligibility.verifiedCorrect).toBe("unknown");
  });
});

describe("assembleLearnerState with cartridge evidence", () => {
  const evidence = () => courseEvidence({ ...qualifiedInput, observation: { ...qualifiedInput.observation, requirementKey: "408.ds.stack.lifo-trace" } });
  const read = (cartridgeEvidence?: CartridgeEvidenceInput) => assembleLearnerState({ evidence: evidence(),
    stateVersion: "state-1", dataAsOf: "2026-11-20T00:00:00.000Z", ...(cartridgeEvidence ? { cartridgeEvidence } : {}) });
  const withEmission = (emission: CartridgeObservationEmission) => read({ registry, emissions: { [learningObservation.id]: emission } });

  it("is unchanged when no cartridge evidence is supplied or none matches the observation", () => {
    expect(read({ registry, emissions: {} })).toEqual(read());
    expect(read({ registry, emissions: { other: emit({ cartridgeId: "408.stack.practice" }) } })).toEqual(read());
  });

  it("keeps formal progression for a verified L4 probe", () => {
    const result = withEmission(emit());
    expect(result.features[0]).toMatchObject({ eligibility: { verifiedCorrect: "yes", independentAttempt: "yes" },
      views: ["independent", "retention"] });
    expect(result.features[0]!.gaps).not.toContain("cartridge_evidence_not_qualified");
    expect(result.display.requirements[0]?.state).toBe("independent");
    expect(result.summary[0]?.status).toBe("observed_independent");
  });

  it.each([
    ["an L3 cartridge", emit({ cartridgeId: "408.stack.practice" })],
    ["an unverified probe", emit({ cartridgeId: "408.stack.lenient", probeId: degenerate.probeId, response: { verdict: "feasible" } })],
  ])("keeps %s as practice feedback only", (_name, emission) => {
    const result = withEmission(emission);
    expect(result.features[0]).toMatchObject({ eligibility: { verifiedCorrect: "unknown", independentAttempt: "yes", usableForDelayedCheck: "unknown" },
      views: ["independent"] });
    expect(result.features[0]!.gaps).toEqual(expect.arrayContaining(["correctness_unverified", "cartridge_evidence_not_qualified"]));
    expect(result.display.requirements[0]?.state).toBe("insufficient");
    expect(result.summary[0]?.status).toBe("needs_check");
    expect(result.policyVersion).toBe(read().policyVersion);
  });
});
