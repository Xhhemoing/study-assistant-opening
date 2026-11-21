import { describe, expect, it } from "vitest";
import { evaluateProbeWithSnapshot, evaluateProbeWithSpec } from "./capability-helpers";
import {
  classifyProbeResponse,
  classifyProbeResponseWithSnapshot,
  snapshotAndVerifyProbe,
  verifyProbeDistinguishability,
  type DistinguishableProbeSpec,
  type MisconceptionHypothesis,
  type VerifiedProbeSnapshot,
} from "./probe-protocol";

type Spec = DistinguishableProbeSpec<number, number>;
const hypothesis = (id: string, predict: (x: number) => number): MisconceptionHypothesis<number, number> =>
  ({ id, role: "misconception", label: id, description: id, predict });

const H_ADD = hypothesis("H_ADD_INSTEAD_OF_DOUBLE", x => x + 2);
const H_SQUARE = hypothesis("H_SQUARE_INSTEAD_OF_DOUBLE", x => x * x);

function spec(input: number, hypotheses = [H_ADD, H_SQUARE], overrides: Partial<Spec> = {}): Spec {
  return {
    probeId: `double-${input}`, requirementKey: "toy.double", prompt: "double it", input,
    correctModel: { id: "M_DOUBLE", role: "correct", label: "double", predict: x => x * 2 },
    hypotheses, observableKey: value => String(value),
    parseResponse: raw => typeof raw === "number" && Number.isFinite(raw) ? raw : null,
    ...overrides,
  };
}

describe("verifyProbeDistinguishability", () => {
  it("accepts a probe whose correct model and every hypothesis predict distinct observables", () => {
    const report = verifyProbeDistinguishability(spec(3));
    expect(report).toMatchObject({ probeId: "double-3", distinguishable: true, issues: [], ambiguousPairs: [], degenerateAgainstCorrectModel: [] });
    expect(report.predictions).toEqual([
      { modelId: "M_DOUBLE", role: "correct", observableKey: "6" },
      { modelId: "H_ADD_INSTEAD_OF_DOUBLE", role: "misconception", observableKey: "5" },
      { modelId: "H_SQUARE_INSTEAD_OF_DOUBLE", role: "misconception", observableKey: "9" },
    ]);
  });

  it("rejects H_A(x) = H_B(x) and H_i(x) = M*(x) with structured diagnostics", () => {
    // At x = 2: 2*2 = 2+2 = 2^2 = 4, so nothing is attributable.
    const report = verifyProbeDistinguishability(spec(2));
    expect(report.distinguishable).toBe(false);
    expect(report.issues).toEqual(["ambiguous_hypothesis_pair", "degenerate_against_correct_model"]);
    expect(report.ambiguousPairs).toEqual([{ a: "H_ADD_INSTEAD_OF_DOUBLE", b: "H_SQUARE_INSTEAD_OF_DOUBLE", observableKey: "4" }]);
    expect(report.degenerateAgainstCorrectModel).toEqual([
      { hypothesisId: "H_ADD_INSTEAD_OF_DOUBLE", observableKey: "4" },
      { hypothesisId: "H_SQUARE_INSTEAD_OF_DOUBLE", observableKey: "4" },
    ]);
  });

  it("reports only the ambiguous pair when hypotheses collide but differ from the correct model", () => {
    const H_PLUS_ONE_TWICE = hypothesis("H_PLUS_ONE_TWICE", x => x + 1 + 1);
    const report = verifyProbeDistinguishability(spec(5, [H_ADD, H_PLUS_ONE_TWICE]));
    expect(report.issues).toEqual(["ambiguous_hypothesis_pair"]);
    expect(report.degenerateAgainstCorrectModel).toEqual([]);
    expect(report.ambiguousPairs).toEqual([{ a: "H_ADD_INSTEAD_OF_DOUBLE", b: "H_PLUS_ONE_TWICE", observableKey: "7" }]);
  });

  it("reports every colliding pair even when predictions are interleaved", () => {
    const report = verifyProbeDistinguishability(spec(5, [
      hypothesis("H_C", () => 7), H_SQUARE, hypothesis("H_A", () => 7), hypothesis("H_B", () => 7),
    ]));
    expect(report.ambiguousPairs).toEqual([
      { a: "H_A", b: "H_B", observableKey: "7" },
      { a: "H_A", b: "H_C", observableKey: "7" },
      { a: "H_B", b: "H_C", observableKey: "7" },
    ]);
  });

  it.each([true, false])("rejects a hypothesis iterator that hides a collision (enumerable: %s)", enumerable => {
    const hypotheses = [H_ADD, H_SQUARE, hypothesis("H_PLUS_ONE_TWICE", x => x + 1 + 1)];
    const probe = spec(3, hypotheses);
    expect(snapshotAndVerifyProbe(probe).report.ambiguousPairs).toEqual([
      { a: "H_ADD_INSTEAD_OF_DOUBLE", b: "H_PLUS_ONE_TWICE", observableKey: "5" },
    ]);
    Object.defineProperty(hypotheses, Symbol.iterator, {
      enumerable,
      value: function* () { yield H_ADD; yield H_SQUARE; },
    });

    expect(snapshotAndVerifyProbe(probe)).toMatchObject({
      report: { distinguishable: false, issues: expect.arrayContaining(["prediction_failed"]) },
      correctObservableKey: null,
    });
    expect(evaluateProbeWithSpec(probe, 6)).toMatchObject({ outcome: "unverified", matchedHypothesisId: null });
  });

  it("rejects a sparse hypothesis array even when a hole has an inherited element", () => {
    const hypotheses = [H_ADD, H_SQUARE];
    Reflect.deleteProperty(hypotheses, "1");
    expect(snapshotAndVerifyProbe(spec(3, hypotheses)).report.distinguishable).toBe(false);

    const prototype = Object.create(Array.prototype) as object;
    Object.defineProperty(prototype, "1", { value: H_SQUARE });
    Object.setPrototypeOf(hypotheses, prototype);
    expect(snapshotAndVerifyProbe(spec(3, hypotheses)).report).toMatchObject({
      distinguishable: false, issues: expect.arrayContaining(["prediction_failed"]),
    });
  });

  it("rejects a throwing hypothesis element getter without invoking it", () => {
    const hypotheses = [H_ADD, H_SQUARE];
    let reads = 0;
    Object.defineProperty(hypotheses, "1", {
      get() { reads += 1; throw new Error("hypothesis unavailable"); },
    });

    expect(snapshotAndVerifyProbe(spec(3, hypotheses)).report).toMatchObject({
      distinguishable: false, issues: expect.arrayContaining(["prediction_failed"]),
    });
    expect(reads).toBe(0);
  });

  it("requires competing hypotheses, unique model ids and complete identity", () => {
    expect(verifyProbeDistinguishability(spec(3, [])).issues).toEqual(["no_competing_hypotheses"]);
    expect(verifyProbeDistinguishability(spec(3, [H_ADD, H_ADD])).issues).toContain("duplicate_model_id");
    expect(verifyProbeDistinguishability(spec(3, [H_ADD], { requirementKey: "" })).issues).toEqual(["probe_identity_incomplete"]);
  });

  it.each(["spec", "correct model", "hypothesis"] as const)("rejects a Proxy-backed %s before reading its members", field => {
    const probe = spec(3);
    let reads = 0;
    const get: ProxyHandler<object>["get"] = (target, key) => {
      reads += 1;
      return Reflect.get(target, key);
    };
    const candidate = field === "spec" ? new Proxy(probe, { get }) : {
      ...probe,
      correctModel: field === "correct model" ? new Proxy(probe.correctModel, { get }) : probe.correctModel,
      hypotheses: field === "hypothesis" ? [new Proxy(H_ADD, { get }), H_SQUARE] : probe.hypotheses,
    };

    expect(snapshotAndVerifyProbe(candidate)).toMatchObject({
      report: { distinguishable: false },
      correctObservableKey: null,
    });
    expect(reads).toBe(0);
  });

  it("treats throwing or nondeterministic simulators as unverifiable", () => {
    const throwing = hypothesis("H_THROWS", () => { throw new Error("boom"); });
    expect(verifyProbeDistinguishability(spec(3, [H_ADD, throwing]))).toMatchObject({
      distinguishable: false, issues: ["prediction_failed"] });
    let calls = 0;
    const flaky = hypothesis("H_FLAKY", x => x + (calls++ % 2));
    expect(verifyProbeDistinguishability(spec(3, [H_ADD, flaky])).issues).toEqual(["nondeterministic_prediction"]);
  });

  it("rejects probe and model accessors before reading them", () => {
    const probe = spec(3);
    let reads = 0;
    const probeWithAccessor = { ...probe, get input() { reads += 1; return 3; } };
    const modelWithAccessor = { ...probe.correctModel, get predict() { reads += 1; return probe.correctModel.predict; } };
    expect(verifyProbeDistinguishability(probeWithAccessor).distinguishable).toBe(false);
    expect(verifyProbeDistinguishability({ ...probe, correctModel: modelWithAccessor }).distinguishable).toBe(false);
    expect(reads).toBe(0);
  });

  it("rejects a Proxy-backed snapshot before reading it during evaluation", () => {
    const snapshot = snapshotAndVerifyProbe(spec(3));
    let reads = 0;
    const wrapped = new Proxy(snapshot, { get(target, key) { reads += 1; return Reflect.get(target, key); } });
    expect(evaluateProbeWithSnapshot(wrapped, 6)).toMatchObject({
      evaluation: { outcome: "unverified" }, encodingFailed: true,
    });
    expect(reads).toBe(0);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["number", 42],
    ["object", { k: "v" }],
    ["empty string", ""],
    ["whitespace-only string", "   \t\n "],
  ])("rejects invalid (%s) observable keys returned at runtime", (_label, badKey) => {
    const broken = spec(3, [H_ADD, H_SQUARE], {
      observableKey: value => (value === 5 ? (badKey as unknown as string) : String(value)),
    });
    const report = verifyProbeDistinguishability(broken);
    expect(report.distinguishable).toBe(false);
    expect(report.issues).toContain("invalid_observable_key");
  });
});

describe("probe input isolation", () => {
  const listModel = (id: string, predict: (input: number[]) => number): MisconceptionHypothesis<number[], number> =>
    ({ id, role: "misconception", label: id, description: id, predict });

  it.each(["correct model", "first hypothesis"] as const)("isolates mutations by the %s from later predictors", mutator => {
    const input = [2, 1];
    const sort = (arr: number[]) => arr.sort()[0]!;
    const read = (arr: number[]) => arr[0]! + 1;
    const probe: DistinguishableProbeSpec<number[], number> = {
      ...spec(3), input,
      correctModel: { id: "M", role: "correct", label: "correct", predict: mutator === "correct model" ? sort : () => 3 },
      hypotheses: mutator === "correct model" ? [listModel("H_READ", read), listModel("H_OTHER", () => 3)]
        : [listModel("H_SORT", sort), listModel("H_READ", read)],
    };
    const report = verifyProbeDistinguishability(probe);
    expect(report.distinguishable).toBe(false);
    expect(report.issues).toContain(mutator === "correct model" ? "ambiguous_hypothesis_pair" : "degenerate_against_correct_model");
    expect(input).toEqual([2, 1]);
    expect(evaluateProbeWithSpec(probe, 3)).toMatchObject({ outcome: "unverified", matchedHypothesisId: null });
  });

  it("starts each determinism check with the same private input", () => {
    const input = [2, 1];
    const probe: DistinguishableProbeSpec<number[], number> = {
      ...spec(3), input, hypotheses: [listModel("H_SHIFT", arr => arr.shift()!)],
      correctModel: { id: "M", role: "correct", label: "correct", predict: () => 3 },
    };
    expect(evaluateProbeWithSpec(probe, 2)).toMatchObject({ outcome: "incorrect", matchedHypothesisId: "H_SHIFT" });
    expect(input).toEqual([2, 1]);
  });

  it("rejects nested shared input before any model is invoked", () => {
    let calls = 0;
    const input = { view: new DataView(new SharedArrayBuffer(1)) };
    const base = spec(3);
    const probe: DistinguishableProbeSpec<typeof input, number> = {
      ...base, input,
      correctModel: { ...base.correctModel, predict: () => { calls += 1; return 6; } },
      hypotheses: [{ ...H_ADD, predict: () => { calls += 1; return 5; } }],
    };
    expect(verifyProbeDistinguishability(probe)).toMatchObject({ distinguishable: false, issues: ["prediction_failed"] });
    expect(evaluateProbeWithSpec(probe, 6)).toMatchObject({ outcome: "unverified" });
    expect(calls).toBe(0);
  });
});

describe("classifyProbeResponse", () => {
  it("attributes a response to the unique model that predicts it", () => {
    expect(classifyProbeResponse(spec(3), 6)).toEqual({ observableKey: "6", wellFormed: true, match: { role: "correct", modelId: "M_DOUBLE" } });
    expect(classifyProbeResponse(spec(3), 9).match).toEqual({ role: "misconception", modelId: "H_SQUARE_INSTEAD_OF_DOUBLE" });
    expect(classifyProbeResponse(spec(3), 7)).toEqual({ observableKey: "7", wellFormed: true, match: null });
    expect(classifyProbeResponse(spec(3), "six")).toEqual({ observableKey: null, wellFormed: false, match: null });
  });

  it("never attributes a response on an ambiguous probe", () => {
    expect(classifyProbeResponse(spec(2), 4).match).toBeNull();
  });

  it("rejects non-string, empty, or throwing observable keys on learner responses without crashing", () => {
    const throwingEncoder = spec(3, [H_ADD, H_SQUARE], {
      observableKey: value => {
        if (value === 7) throw new Error("encode crash");
        return String(value);
      },
    });
    expect(classifyProbeResponse(throwingEncoder, 7)).toEqual({ observableKey: null, wellFormed: false, match: null });

    const blankEncoder = spec(3, [H_ADD, H_SQUARE], {
      observableKey: value => (value === 7 ? "   " : String(value)),
    });
    expect(classifyProbeResponse(blankEncoder, 7)).toEqual({ observableKey: null, wellFormed: false, match: null });

    const nullEncoder = spec(3, [H_ADD, H_SQUARE], {
      observableKey: value => (value === 7 ? (null as unknown as string) : String(value)),
    });
    expect(classifyProbeResponse(nullEncoder, 7)).toEqual({ observableKey: null, wellFormed: false, match: null });
  });

  it("rejects a learner response whose key encoding changes between calls", () => {
    let responses = 0;
    const probe = spec(3, [H_ADD, H_SQUARE], {
      observableKey: value => value === 7 ? String(6 + responses++) : String(value),
    });
    expect(evaluateProbeWithSpec(probe, 7)).toMatchObject({ outcome: "unverified", observableKey: null });
  });

  it("isolates responses and normalized observables from mutating callbacks", () => {
    const response = { outputs: [6, 5] };
    const probe: DistinguishableProbeSpec<number, number[]> = {
      ...spec(3),
      correctModel: { id: "M", role: "correct", label: "correct", predict: () => [6] },
      hypotheses: [{ ...H_ADD, predict: () => [5] }],
      parseResponse(raw) {
        const { outputs } = raw as typeof response;
        outputs.pop();
        return outputs;
      },
      observableKey: observable => String(observable.shift()),
    };
    expect(evaluateProbeWithSpec(probe, response)).toMatchObject({ outcome: "correct", observableKey: "6" });
    expect(response).toEqual({ outputs: [6, 5] });
  });

  it("withholds grading when the parser returns an observable with shared backing memory", () => {
    const probe: DistinguishableProbeSpec<number, Uint8Array> = {
      ...spec(3),
      correctModel: { id: "M", role: "correct", label: "correct", predict: () => Uint8Array.of(6) },
      hypotheses: [{ ...H_ADD, predict: () => Uint8Array.of(5) }],
      parseResponse() {
        const observable = new Uint8Array(new SharedArrayBuffer(1));
        observable[0] = 6;
        return observable;
      },
      observableKey: observable => String(observable[0]),
    };
    expect(evaluateProbeWithSpec(probe, 6)).toMatchObject({ outcome: "unverified", observableKey: null });
  });
});

describe("evaluateProbeWithSpec single-snapshot hardening", () => {
  it("evaluates verification and scoring against a single immutable prediction snapshot", () => {
    let correctCalls = 0;
    const statefulSpec = spec(3, [H_ADD, H_SQUARE], {
      correctModel: {
        id: "M_DOUBLE",
        role: "correct",
        label: "double",
        predict: x => {
          correctCalls += 1;
          // Calls 1-2 happen during the single snapshot determinism check; any later re-evaluation would drift.
          return correctCalls <= 2 ? x * 2 : x * 100;
        },
      },
    });
    const evaluation = evaluateProbeWithSpec(statefulSpec, 6);
    expect(correctCalls).toBe(2);
    expect(evaluation).toEqual({
      probeId: "double-3",
      requirementKey: "toy.double",
      outcome: "correct",
      diagnosis: "correct_model",
      matchedHypothesisId: null,
      observableKey: "6",
    });
  });

  it("always withholds graded outcomes when probe verification fails", () => {
    // Degenerate probe (H_i(2) == M*(2) == 4)
    expect(evaluateProbeWithSpec(spec(2), 4)).toMatchObject({
      outcome: "unverified",
      diagnosis: "unclassified",
      matchedHypothesisId: null,
      observableKey: null,
    });
    // Ambiguous hypothesis pair (H_ADD(5) == H_PLUS_ONE_TWICE(5) == 7) even if response equals M*(5) == 10
    const H_PLUS_ONE_TWICE = hypothesis("H_PLUS_ONE_TWICE", x => x + 1 + 1);
    expect(evaluateProbeWithSpec(spec(5, [H_ADD, H_PLUS_ONE_TWICE]), 10)).toMatchObject({
      outcome: "unverified",
      diagnosis: "unclassified",
      matchedHypothesisId: null,
      observableKey: null,
    });
  });

  it("deeply freezes VerifiedProbeSnapshot and prevents external tampering with its scoring table", () => {
    const snapshot = snapshotAndVerifyProbe(spec(3));
    expect("hypothesisByObservableKey" in snapshot).toBe(false);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.report)).toBe(true);
    expect(Object.isFrozen(snapshot.report.predictions)).toBe(true);
    expect(Object.isFrozen(snapshot.report.predictions[0])).toBe(true);

    const degenerateSnapshot = snapshotAndVerifyProbe(spec(2));
    expect(Object.isFrozen(degenerateSnapshot.report.ambiguousPairs)).toBe(true);
    expect(Object.isFrozen(degenerateSnapshot.report.ambiguousPairs[0])).toBe(true);
    expect(Object.isFrozen(degenerateSnapshot.report.degenerateAgainstCorrectModel)).toBe(true);
    expect(Object.isFrozen(degenerateSnapshot.report.degenerateAgainstCorrectModel[0])).toBe(true);

    // Unmatched response 7 stays unclassified and cannot be injected via a forged Map property.
    expect(classifyProbeResponseWithSnapshot(snapshot, 7)).toEqual({
      classification: { observableKey: "7", wellFormed: true, match: null },
      encodingFailed: false,
    });
    const forgedSnapshot = {
      ...snapshot,
      hypothesisByObservableKey: new Map([["7", "H_INJECTED"]]),
    } as unknown as VerifiedProbeSnapshot<number>;
    expect(classifyProbeResponseWithSnapshot(forgedSnapshot, 7)).toEqual({
      classification: { observableKey: null, wellFormed: false, match: null },
      encodingFailed: true,
    });
  });
});
