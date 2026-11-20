import { BlockList } from "node:net";
import { describe, expect, it, vi } from "vitest";
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

  it.each(["constructor", "__proto__", "toString", "valueOf"])("withholds prototype alias %s", token => {
    expect(qualifyCartridgeEmission(registry, emit({ response: { outputs: [token], finalTop: -1 } })))
      .toMatchObject({ qualified: false, reasonCodes: ["cartridge_response_invalid"] });
  });

  it("withholds sparse trace outputs", () => {
    const outputs: number[] = [];
    outputs[1] = 1;
    expect(qualifyCartridgeEmission(registry, emit({ response: { outputs, finalTop: -1 } })))
      .toMatchObject({ qualified: false, reasonCodes: ["cartridge_response_invalid"] });
  });

  const shared = new SharedArrayBuffer(8);
  it.each([
    ["direct shared buffer", shared],
    ["shared typed array in a Map key", new Map([[new Uint8Array(shared), 1]])],
    ["shared DataView in a Set", new Set([new DataView(shared)])],
    ["shared buffer in a non-enumerable Error cause", new Error("nested", { cause: shared })],
    ["shared WebAssembly memory", new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true })],
  ] as const)("rejects a response containing a %s", (_label, data) => {
    const metadata: { self?: unknown; data: unknown } = { data };
    metadata.self = metadata;
    expect(qualifyCartridgeEmission(registry, emit({ response: { ...CORRECT, metadata } })))
      .toMatchObject({ qualified: false, reasonCodes: ["cartridge_response_invalid"] });
  });

  it("rejects Node BlockList data before lookup can mutate its backing state", () => {
    const blockList = new BlockList();
    const address = "192.0.2.1";
    const base = stack408Cartridge.getProbe(TRACE_PROBE)!;
    const probe = {
      ...base,
      parseResponse: vi.fn((raw: unknown) => {
        const { rules } = raw as { rules: BlockList };
        return base.parseResponse(rules.check(address) ? CORRECT : FIFO);
      }),
    };
    const getProbe = vi.fn(() => probe);
    const evaluateProbeResponse = vi.fn((_id: string, raw: unknown) => evaluateProbeWithSpec(probe, raw));
    const localRegistry = createCartridgeRegistry([{
      ...stack408Cartridge, listProbes: () => [probe], getProbe, evaluateProbeResponse,
    }]);
    getProbe.mockClear().mockImplementation(() => {
      blockList.addAddress(address);
      return probe;
    });
    const lookup = vi.spyOn(localRegistry, "getCartridge");

    expect(qualifyCartridgeEmission(localRegistry, emit({ response: { rules: blockList } }))).toMatchObject({
      qualified: false, reasonCodes: ["cartridge_response_invalid"],
    });
    expect(lookup).not.toHaveBeenCalled();
    expect(getProbe).not.toHaveBeenCalled();
    expect(probe.parseResponse).not.toHaveBeenCalled();
    expect(evaluateProbeResponse).not.toHaveBeenCalled();
    expect(blockList.check(address)).toBe(false);
  });

  it("captures the response once and isolates private bytes from lookup and both scorers", () => {
    const bytes = new Uint8Array([2]);
    let responseReads = 0;
    const base = stack408Cartridge.getProbe(TRACE_PROBE)!;
    const probe = {
      ...base,
      parseResponse(raw: unknown) {
        const { bytes, view, buffer } = raw as { bytes: Uint8Array; view: DataView; buffer: ArrayBuffer };
        if (bytes.buffer !== buffer || view.buffer !== buffer) return null;
        const outputs = [view.getUint8(0), 3, 1, "UNDERFLOW"];
        bytes[0] = 99;
        return base.parseResponse({ outputs, finalTop: -1 });
      },
    };
    const localRegistry = createCartridgeRegistry([{
      ...stack408Cartridge,
      listProbes: () => [probe],
      getProbe: () => {
        if (responseReads > 0) bytes[0] = 88;
        return probe;
      },
      evaluateProbeResponse: (_id: string, response: unknown) => evaluateProbeWithSpec(probe, response),
    }]);
    const emission = {
      ...emit(),
      get response() {
        responseReads += 1;
        const payload: { bytes: Uint8Array; view: DataView; buffer: ArrayBufferLike; self?: unknown } = {
          bytes, view: new DataView(bytes.buffer), buffer: bytes.buffer,
        };
        payload.self = payload;
        return payload;
      },
    };
    expect(qualifyCartridgeEmission(localRegistry, emission)).toMatchObject({
      qualified: true, evaluation: { outcome: "correct", diagnosis: "correct_model" },
    });
    expect(responseReads).toBe(1);
    expect(bytes[0]).toBe(88);
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

  it("snapshots emission and observation before callbacks so in-place mutation during getProbe cannot spoof identity or response", () => {
    const mutableEmission = emit({ cartridgeId: "408.stack.mutator", probeId: "original", response: { outputs: "1,2,3,UNDERFLOW", finalTop: -1 } });
    const mutatingProbeCartridge = {
      ...stack408Cartridge,
      manifest: { ...stack408Cartridge.manifest, id: "408.stack.mutator" },
      getProbe: (id: string) => {
        if (id === "original") {
          // Mutate the caller's emission object in place to try matching the returned probeId and correct response.
          mutableEmission.probeId = TRACE_PROBE;
          (mutableEmission.response as { outputs: string }).outputs = "2,3,1,UNDERFLOW";
          return stack408Cartridge.getProbe(TRACE_PROBE);
        }
        return stack408Cartridge.getProbe(id);
      },
    };
    const localRegistry = createCartridgeRegistry([mutatingProbeCartridge]);
    const identityResult = qualifyCartridgeEmission(localRegistry, mutableEmission, { outcome: "correct" });
    expect(identityResult.qualified).toBe(false);
    expect(identityResult.probeId).toBe("original");
    expect(identityResult.reasonCodes).toEqual(["cartridge_probe_identity_mismatch"]);

    // Even when probeId matches, mutating emission.response in place during getProbe cannot overwrite the captured response.
    const mutableResponseEmission = emit({
      cartridgeId: "408.stack.resp-mutator",
      probeId: TRACE_PROBE,
      response: { outputs: "1,2,3,UNDERFLOW", finalTop: -1 },
    });
    let armed = false;
    const mutatingResponseCartridge = {
      ...stack408Cartridge,
      manifest: { ...stack408Cartridge.manifest, id: "408.stack.resp-mutator" },
      getProbe: (id: string) => {
        if (armed) (mutableResponseEmission.response as { outputs: string }).outputs = "2,3,1,UNDERFLOW";
        return stack408Cartridge.getProbe(id);
      },
    };
    const respRegistry = createCartridgeRegistry([mutatingResponseCartridge]);
    armed = true;
    const respResult = qualifyCartridgeEmission(respRegistry, mutableResponseEmission, { outcome: "correct" });
    expect(respResult.qualified).toBe(false);
    expect(respResult.evaluation?.outcome).toBe("incorrect");
    expect(respResult.reasonCodes).toEqual(["cartridge_outcome_conflict"]);
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

  it("evaluates each observation gate once and never lets a withheld baseline qualify a transfer observation", () => {
    const baseProbe = stack408Cartridge.getProbe(TRACE_PROBE)!;
    let gateLookups = 0;
    let registrationDone = false;
    const flakyBaselineCartridge = {
      ...stack408Cartridge,
      manifest: { ...stack408Cartridge.manifest, id: "408.stack.flaky-baseline" },
      getProbe: (id: string) => {
        if (registrationDone && id === TRACE_PROBE) {
          gateLookups += 1;
          // First gate evaluation fails; a second re-evaluation of the same baseline would succeed if uncached.
          if (gateLookups === 1) return degenerate;
        }
        return stack408Cartridge.getProbe(id);
      },
    };
    const localRegistry = createCartridgeRegistry([stack408Cartridge, flakyBaselineCartridge]);
    registrationDone = true;

    const baselineTime = "2026-11-18T10:00:00.000Z";
    const transferTime = "2026-11-19T10:00:00.000Z";
    const baselineObs = { ...learningObservation, id: "obs-baseline", submittedAt: baselineTime, occurredAt: baselineTime };
    const transferObs = { ...learningObservation, id: "obs-transfer", submittedAt: transferTime, occurredAt: transferTime };
    const transferServerEval = {
      evaluatorVersion: "span-exact-v1",
      specVersion: "span-v1",
      decision: "correct" as const,
      outcome: "correct" as const,
      coreEvidenceComplete: true,
      observationId: "obs-transfer",
      attemptId: qualifiedInput.observation.attemptId!,
      problemId: qualifiedInput.observation.problemId!,
      itemVersionId: qualifiedInput.observation.itemVersionId!,
      requirementKey: "408.ds.stack.lifo-trace",
      skills: { equation: "correct" as const, coefficients: "correct" as const, allCoordinates: "correct" as const, systemConsistency: "correct" as const },
    };
    const twoObsEvidence = {
      observations: [baselineObs, transferObs],
      evidenceContexts: {
        "obs-baseline": {
          observation: { ...qualifiedInput.observation, requirementKey: "408.ds.stack.lifo-trace", submittedAt: Date.parse(baselineTime) },
          context: qualifiedInput.context,
        },
        "obs-transfer": {
          observation: { ...qualifiedInput.observation, requirementKey: "408.ds.stack.lifo-trace", submittedAt: Date.parse(transferTime) },
          context: { ...qualifiedInput.context, serverEvaluation: transferServerEval },
        },
      },
    };
    const transferSpecifications = {
      "obs-transfer": {
        fromFamilyId: "family-base",
        familyId: "family-transfer",
        changes: ["boundary-variation"],
        knowledgeComponents: ["span:vector-equation"],
      },
    };
    const observationFamilies = { "obs-baseline": "family-base", "obs-transfer": "family-transfer" };

    // Control: when the baseline is qualified, transfer is usable.
    const control = assembleLearnerState({
      evidence: twoObsEvidence,
      stateVersion: "state-control",
      dataAsOf: "2026-11-20T00:00:00.000Z",
      transferSpecifications,
      observationFamilies,
      cartridgeEvidence: { registry: localRegistry, emissions: { "obs-baseline": emit() } },
    });
    expect(control.features[1]?.transfer.usable).toBe("yes");

    // Stateful baseline that fails its first (and only) gate check must stay withheld and cannot establish transfer baseline.
    const result = assembleLearnerState({
      evidence: twoObsEvidence,
      stateVersion: "state-1",
      dataAsOf: "2026-11-20T00:00:00.000Z",
      transferSpecifications,
      observationFamilies,
      cartridgeEvidence: {
        registry: localRegistry,
        emissions: { "obs-baseline": emit({ cartridgeId: "408.stack.flaky-baseline", probeId: baseProbe.probeId }) },
      },
    });
    expect(gateLookups).toBe(1);
    expect(result.features[0]).toMatchObject({
      observationId: "obs-baseline",
      eligibility: { verifiedCorrect: "unknown" },
    });
    expect(result.features[1]).toMatchObject({
      observationId: "obs-transfer",
      transfer: { usable: "unknown", reasonCodes: ["transfer_baseline_not_established"] },
    });
  });

  it("rejects non-cloneable object responses without reading live mutable properties during scoring", () => {
    const valid = emit().response as Record<string, unknown>;
    let getterReads = 0;
    const uncloneable = {
      ...valid,
      uncloneableFn: () => "cannot clone",
      get popped() {
        getterReads += 1;
        return valid.popped;
      },
    };
    const qualification = qualifyCartridgeEmission(registry, emit({ response: uncloneable }));
    expect(qualification.qualified).toBe(false);
    expect(qualification.reasonCodes).toEqual(["cartridge_response_invalid"]);
    expect(getterReads).toBe(0);
  });
});
