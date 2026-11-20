import { describe, expect, it } from "vitest";
import { isCitationGrounded } from "./capability-helpers";
import { verifyProbeDistinguishability } from "./probe-protocol";
import { createCartridgeRegistry } from "./registry";
import {
  STACK_408_REQUIREMENTS,
  createInitialStack408State,
  enumerateFeasiblePopSequences,
  recordStack408ProbeAttempt,
  simulateBypassLifoFeasibility,
  simulateCorrectFeasibility,
  simulateCorrectStackTrace,
  simulateFifoQueueConfusionFeasibility,
  simulateFifoQueueConfusionTrace,
  simulateTopPointerOffByOneFeasibility,
  simulateTopPointerOffByOneTrace,
  stack408Cartridge,
  type StackTraceInput,
} from "./stack-408-v1";
import { CartridgeContinuityStateError, type CartridgeMaterialChunk, type ContinuityCartridge } from "./types";

const TRACE_PROBE = "408.stack.trace.interleaved-underflow.v1";
const POINTER_PROBE = "408.stack.pointer.pre-increment.v1";
const FEASIBILITY_PROBE = "408.stack.pop-sequence.catalan-invalid.v1";

const interleaved: StackTraceInput = { capacity: 4, ops: [
  { op: "push", value: 1 }, { op: "push", value: 2 }, { op: "pop" }, { op: "push", value: 3 }, { op: "pop" }, { op: "pop" }, { op: "pop" }] };

function permutations(values: number[]): number[][] {
  if (values.length <= 1) return [values];
  return values.flatMap((value, index) => permutations([...values.slice(0, index), ...values.slice(index + 1)]).map(rest => [value, ...rest]));
}

describe("408.stack.v1 simulators", () => {
  it("traces the correct model and each competing misconception deterministically", () => {
    expect(simulateCorrectStackTrace(interleaved)).toEqual({ outputs: ["2", "3", "1", "UNDERFLOW"], finalTop: -1 });
    expect(simulateFifoQueueConfusionTrace(interleaved)).toEqual({ outputs: ["1", "2", "3", "UNDERFLOW"], finalTop: -1 });
    expect(simulateTopPointerOffByOneTrace(interleaved)).toEqual({ outputs: ["UNINITIALIZED", "UNINITIALIZED", "3", "UNDERFLOW"], finalTop: -1 });
  });

  it("detects overflow under the ++top convention", () => {
    const input: StackTraceInput = { capacity: 2, ops: [{ op: "push", value: 1 }, { op: "push", value: 2 }, { op: "push", value: 3 }, { op: "pop" }] };
    expect(simulateCorrectStackTrace(input)).toEqual({ outputs: ["OVERFLOW", "2"], finalTop: 0 });
  });

  it("judges pop-sequence feasibility per model", () => {
    const input = { pushOrder: [1, 2, 3, 4], candidatePops: [2, 4, 1, 3] };
    expect(simulateCorrectFeasibility(input)).toEqual({ verdict: "infeasible", firstViolationIndex: 2 });
    expect(simulateFifoQueueConfusionFeasibility(input)).toEqual({ verdict: "infeasible", firstViolationIndex: 0 });
    expect(simulateTopPointerOffByOneFeasibility(input)).toEqual({ verdict: "infeasible", firstViolationIndex: 1 });
    expect(simulateBypassLifoFeasibility(input)).toEqual({ verdict: "feasible", firstViolationIndex: null });
    expect(simulateBypassLifoFeasibility({ pushOrder: [1, 2], candidatePops: [2, 2] })).toEqual({ verdict: "infeasible", firstViolationIndex: 1 });
  });

  it("matches the Catalan count of valid pop orders", () => {
    expect(enumerateFeasiblePopSequences([1, 2, 3, 4])).toHaveLength(14);
    expect(enumerateFeasiblePopSequences([1, 2, 3, 4, 5])).toHaveLength(42);
    const valid = new Set(enumerateFeasiblePopSequences([1, 2, 3, 4]).map(row => row.join(",")));
    for (const candidatePops of permutations([1, 2, 3, 4])) {
      const verdict = simulateCorrectFeasibility({ pushOrder: [1, 2, 3, 4], candidatePops }).verdict;
      expect(verdict === "feasible").toBe(valid.has(candidatePops.join(",")));
    }
  });

  it("handles repeated push symbols consistently between feasibility checking and sequence enumeration", () => {
    const uniquePermutations = (values: number[]): number[][] => {
      const seen = new Set<string>();
      const out: number[][] = [];
      for (const perm of permutations(values)) {
        const key = perm.join(",");
        if (!seen.has(key)) { seen.add(key); out.push(perm); }
      }
      return out;
    };

    for (const pushOrder of [[1, 2, 1], [1, 2, 1, 3], [1, 1, 2, 2], [1, 2, 1, 3, 4]]) {
      const enumerated = enumerateFeasiblePopSequences(pushOrder);
      const enumeratedKeys = enumerated.map(row => row.join(","));
      // Enumeration must not emit duplicate sequences.
      expect(new Set(enumeratedKeys).size).toBe(enumeratedKeys.length);
      const valid = new Set(enumeratedKeys);
      for (const candidatePops of uniquePermutations(pushOrder)) {
        const verdict = simulateCorrectFeasibility({ pushOrder, candidatePops }).verdict;
        expect(verdict === "feasible").toBe(valid.has(candidatePops.join(",")));
      }
    }

    // Backtracking required: popping the first 1 immediately dead-ends, whereas pushing past it succeeds.
    expect(simulateCorrectFeasibility({ pushOrder: [1, 2, 1, 3], candidatePops: [1, 3, 2, 1] }))
      .toEqual({ verdict: "feasible", firstViolationIndex: null });
    expect(simulateCorrectFeasibility({ pushOrder: [1, 2, 1, 3, 4], candidatePops: [1, 4, 3, 2, 1] }))
      .toEqual({ verdict: "feasible", firstViolationIndex: null });

    // Exact violation index on repeated-symbol LIFO and multiplicity violations.
    expect(simulateCorrectFeasibility({ pushOrder: [1, 2, 1, 3], candidatePops: [3, 1, 1, 2] }))
      .toEqual({ verdict: "infeasible", firstViolationIndex: 2 });
    expect(simulateCorrectFeasibility({ pushOrder: [1, 2, 1], candidatePops: [1, 1, 1] }))
      .toEqual({ verdict: "infeasible", firstViolationIndex: 2 });
    expect(simulateBypassLifoFeasibility({ pushOrder: [1, 2, 1], candidatePops: [1, 1, 2] }))
      .toEqual({ verdict: "feasible", firstViolationIndex: null });
    expect(simulateBypassLifoFeasibility({ pushOrder: [1, 2, 1], candidatePops: [1, 1, 1] }))
      .toEqual({ verdict: "infeasible", firstViolationIndex: 2 });
    expect(simulateFifoQueueConfusionFeasibility({ pushOrder: [1, 2, 1], candidatePops: [1, 2, 1] }))
      .toEqual({ verdict: "feasible", firstViolationIndex: null });
  });
});

describe("408.stack.v1 probes", () => {
  it("ships only probes passing the distinguishability pre-check", () => {
    const reports = stack408Cartridge.listProbes().map(verifyProbeDistinguishability);
    expect(reports.map(report => [report.probeId, report.distinguishable])).toEqual([
      [TRACE_PROBE, true], [POINTER_PROBE, true], [FEASIBILITY_PROBE, true]]);
    expect(reports[2]!.predictions.map(row => row.modelId)).toEqual([
      "M_CORRECT_LIFO", "H_FIFO_QUEUE_CONFUSION", "H_TOP_POINTER_OFF_BY_ONE", "H_BYPASS_LIFO_ORDER"]);
  });

  it.each([
    [TRACE_PROBE, { outputs: "2,3,1,UNDERFLOW", finalTop: -1 }, "correct", "correct_model", null],
    [TRACE_PROBE, { outputs: [1, 2, 3, "underflow"], finalTop: -1 }, "incorrect", "misconception", "H_FIFO_QUEUE_CONFUSION"],
    [TRACE_PROBE, { outputs: ["UNINITIALIZED", "garbage", 3, "下溢"], finalTop: -1 }, "incorrect", "misconception", "H_TOP_POINTER_OFF_BY_ONE"],
    [TRACE_PROBE, { outputs: "2,1,3,UNDERFLOW", finalTop: -1 }, "incorrect", "unclassified", null],
    [TRACE_PROBE, { outputs: "two", finalTop: -1 }, "unverified", "invalid_response", null],
    [POINTER_PROBE, { outputs: ["OVERFLOW", 9], finalTop: 1 }, "correct", "correct_model", null],
    [POINTER_PROBE, { outputs: ["上溢", "UNINITIALIZED"], finalTop: 1 }, "incorrect", "misconception", "H_TOP_POINTER_OFF_BY_ONE"],
    [FEASIBILITY_PROBE, { verdict: "infeasible", firstViolationIndex: 2 }, "correct", "correct_model", null],
    [FEASIBILITY_PROBE, { verdict: "feasible" }, "incorrect", "misconception", "H_BYPASS_LIFO_ORDER"],
    [FEASIBILITY_PROBE, { verdict: "infeasible", firstViolationIndex: 0 }, "incorrect", "misconception", "H_FIFO_QUEUE_CONFUSION"],
    [FEASIBILITY_PROBE, { verdict: "infeasible", firstViolationIndex: 1 }, "incorrect", "misconception", "H_TOP_POINTER_OFF_BY_ONE"],
    [FEASIBILITY_PROBE, { verdict: "infeasible", firstViolationIndex: 3 }, "incorrect", "unclassified", null],
    [FEASIBILITY_PROBE, { verdict: "infeasible", firstViolationIndex: 9 }, "unverified", "invalid_response", null],
  ] as const)("evaluates %s response %j", (probeId, response, outcome, diagnosis, matchedHypothesisId) => {
    expect(stack408Cartridge.evaluateProbeResponse(probeId, response)).toMatchObject({ probeId, outcome, diagnosis, matchedHypothesisId });
  });

  it("does not evaluate unknown probes", () => {
    expect(stack408Cartridge.evaluateProbeResponse("missing", {})).toMatchObject({ outcome: "unverified", diagnosis: "invalid_response" });
  });
});

describe("408.stack.v1 continuity (L1)", () => {
  const evaluation = stack408Cartridge.evaluateProbeResponse(TRACE_PROBE, { outputs: "2,3,1,UNDERFLOW", finalTop: -1 });

  it("round-trips serialized state and advances the resume point", () => {
    const state = recordStack408ProbeAttempt(createInitialStack408State(), evaluation, "2026-11-19T00:00:00.000Z");
    const parsed = stack408Cartridge.parseContinuityState(stack408Cartridge.serializeContinuityState(state));
    expect(parsed).toEqual({ ok: true, value: state });
    expect(stack408Cartridge.buildResumeSummary(state)).toMatchObject({ completedSteps: 1, totalSteps: 3,
      nextRequirementKey: "408.ds.stack.pointer-convention" });
  });

  it("rejects malformed or inconsistent state", () => {
    expect(stack408Cartridge.parseContinuityState("{")).toEqual({ ok: false, issues: ["state_not_json"] });
    expect(stack408Cartridge.parseContinuityState({ ...createInitialStack408State(), extra: 1 }).ok).toBe(false);
    const state = recordStack408ProbeAttempt(createInitialStack408State(), evaluation, "2026-11-19T00:00:00.000Z");
    const tampered = { ...state, probeHistory: [{ ...state.probeHistory[0]!, requirementKey: "408.ds.stack.pointer-convention" }] };
    expect(stack408Cartridge.parseContinuityState(tampered)).toMatchObject({ ok: false });
  });

  it.each([
    ["correct", "invalid_response", null],
    ["correct", "correct_model", "H_FIFO_QUEUE_CONFUSION"],
    ["correct", "correct_model", "M_CORRECT_LIFO"],
    ["incorrect", "correct_model", null],
    ["correct", "misconception", "H_FIFO_QUEUE_CONFUSION"],
    ["incorrect", "misconception", null],
    ["incorrect", "misconception", "H_UNKNOWN"],
    ["incorrect", "misconception", "H_BYPASS_LIFO_ORDER"],
    ["correct", "unclassified", null],
    ["unverified", "unclassified", "H_FIFO_QUEUE_CONFUSION"],
    ["incorrect", "invalid_response", null],
    ["unverified", "invalid_response", "H_FIFO_QUEUE_CONFUSION"],
  ] as const)("rejects persisted %s / %s / %s entries", (outcome, diagnosis, matchedHypothesisId) => {
    const state = recordStack408ProbeAttempt(createInitialStack408State(), evaluation, "2026-11-19T00:00:00.000Z");
    const tampered = { ...state, probeHistory: [{ ...state.probeHistory[0], outcome, diagnosis, matchedHypothesisId }] };
    const persisted = JSON.stringify(tampered);
    expect(stack408Cartridge.parseContinuityState(persisted)).toMatchObject({
      ok: false, issues: [expect.stringContaining("probeHistory.0")],
    });
    const cartridge: ContinuityCartridge = stack408Cartridge;
    const registered = createCartridgeRegistry([cartridge]).getCartridge(cartridge.manifest.id)!;
    expect(() => cartridge.buildResumeSummary(persisted)).toThrow(CartridgeContinuityStateError);
    expect(() => registered.buildResumeSummary(persisted)).toThrow(CartridgeContinuityStateError);
  });

  it.each([
    ["incorrect", "misconception", "H_FIFO_QUEUE_CONFUSION"],
    ["incorrect", "unclassified", null],
    ["unverified", "unclassified", null],
    ["unverified", "invalid_response", null],
  ] as const)("restores %s / %s / %s entries without completing the checkpoint", (outcome, diagnosis, matchedHypothesisId) => {
    const state = recordStack408ProbeAttempt(createInitialStack408State(),
      { ...evaluation, outcome, diagnosis, matchedHypothesisId }, "2026-11-19T00:00:00.000Z");
    const persisted = stack408Cartridge.serializeContinuityState(state);
    expect(stack408Cartridge.parseContinuityState(persisted)).toEqual({ ok: true, value: state });
    const cartridge: ContinuityCartridge = stack408Cartridge;
    expect(cartridge.buildResumeSummary(persisted)).toMatchObject({
      completedSteps: 0, nextRequirementKey: "408.ds.stack.lifo-trace",
    });
  });

  it("validates unknown state and accepts serialized state in the direct resume summary", () => {
    const cartridge: ContinuityCartridge = stack408Cartridge;
    expect(cartridge.buildResumeSummary(JSON.stringify(createInitialStack408State()))).toMatchObject({
      completedSteps: 0, totalSteps: 3, nextRequirementKey: "408.ds.stack.lifo-trace",
    });
    expect(() => cartridge.buildResumeSummary({})).toThrow(expect.objectContaining({
      name: "CartridgeContinuityStateError", issues: expect.any(Array),
    }));
    const unreadable = { get probeHistory() { throw new Error("history unavailable"); } };
    expect(() => cartridge.buildResumeSummary(unreadable)).toThrow(expect.objectContaining({
      name: "CartridgeContinuityStateError", issues: ["history unavailable"],
    }));
  });
});

describe("408.stack.v1 scheduling (L2)", () => {
  const now = "2026-11-20T00:00:00.000Z";

  it("projects learn candidates in curriculum order for a fresh learner", () => {
    const candidates = stack408Cartridge.projectTaskCandidates({ state: createInitialStack408State(), now, activeRetestWindows: [] });
    expect(candidates.map(row => [row.requirementKey, row.kind, row.priority])).toEqual(
      STACK_408_REQUIREMENTS.map((key, index) => [key, "learn", 100 - index * 10]));
  });

  it("prioritises misconceptions and respects active and upcoming retest windows", () => {
    let state = createInitialStack408State();
    state = recordStack408ProbeAttempt(state, stack408Cartridge.evaluateProbeResponse(TRACE_PROBE,
      { outputs: "2,3,1,UNDERFLOW", finalTop: -1 }), "2026-11-19T00:00:00.000Z");
    state = recordStack408ProbeAttempt(state, stack408Cartridge.evaluateProbeResponse(POINTER_PROBE,
      { outputs: ["OVERFLOW", "UNINITIALIZED"], finalTop: 1 }), "2026-11-19T01:00:00.000Z");
    const candidates = stack408Cartridge.projectTaskCandidates({ state, now, activeRetestWindows: [
      { requirementKey: "408.ds.stack.pop-sequence-feasibility", opensAt: "2026-11-19T00:00:00.000Z", closesAt: "2026-11-21T00:00:00.000Z" },
      { requirementKey: "408.ds.stack.lifo-trace", opensAt: "2026-11-21T00:00:00.000Z", closesAt: "2026-11-23T00:00:00.000Z" },
    ] });
    expect(candidates).toEqual([
      { candidateId: "408.stack.v1:408.ds.stack.pointer-convention:practice", requirementKey: "408.ds.stack.pointer-convention",
        kind: "practice", cadenceDays: 1, earliestAt: now, priority: 140 },
      { candidateId: "408.stack.v1:408.ds.stack.lifo-trace:review", requirementKey: "408.ds.stack.lifo-trace",
        kind: "review", cadenceDays: 3, earliestAt: "2026-11-23T00:00:00.000Z", priority: 50 },
    ]);
  });
});

describe("408.stack.v1 material binding (L3)", () => {
  const chunks: CartridgeMaterialChunk[] = [
    { sourceId: "src-ds", sourceVersion: 2, chunkId: "c1", page: 41,
      text: "栈是一种后进先出（LIFO）的线性表。例：入栈序列为 1, 2, 3, 4，问哪些出栈序列合法？其数目为卡特兰数。" },
    { sourceId: "src-ds", sourceVersion: 2, chunkId: "c2", page: 42,
      text: "Stack trace example: push(1), push(2), pop(), push(3), pop(), pop()" },
    { sourceId: "src-ds", sourceVersion: 2, chunkId: "c3", page: 43, text: "队列是先进先出的线性表：push 1, push 2, pop" },
  ];

  it("binds only stack-anchored chunks to requirements", () => {
    const bindings = stack408Cartridge.bindMaterialChunks(chunks);
    expect(bindings.map(row => [row.chunkId, row.requirementKey])).toEqual([
      ["c1", "408.ds.stack.lifo-trace"], ["c1", "408.ds.stack.pop-sequence-feasibility"], ["c2", "408.ds.stack.lifo-trace"]]);
    expect(bindings[1]!.matchedTerms).toEqual(expect.arrayContaining(["入栈序列", "出栈序列", "卡特兰"]));
  });

  it("extracts citation-grounded exercise seeds", () => {
    const seeds = stack408Cartridge.extractExerciseSeeds(chunks, stack408Cartridge.bindMaterialChunks(chunks));
    expect(seeds.map(seed => [seed.requirementKey, seed.parameters, seed.citation.quote])).toEqual([
      ["408.ds.stack.pop-sequence-feasibility", { pushOrder: "1,2,3,4" }, "入栈序列为 1, 2, 3, 4"],
      ["408.ds.stack.lifo-trace", { ops: "push 1, push 2, pop, push 3, pop, pop" }, "push(1), push(2), pop(), push(3), pop(), pop()"],
    ]);
    for (const seed of seeds) expect(isCitationGrounded(seed.citation, chunks)).toBe(true);
    expect(isCitationGrounded({ ...seeds[0]!.citation, quote: "入栈序列为 4, 3, 2, 1" }, chunks)).toBe(false);
    expect(isCitationGrounded({ ...seeds[0]!.citation, sourceVersion: 3 }, chunks)).toBe(false);
  });

  it("emits no seeds without bindings", () => {
    expect(stack408Cartridge.extractExerciseSeeds(chunks, [])).toEqual([]);
  });
});
