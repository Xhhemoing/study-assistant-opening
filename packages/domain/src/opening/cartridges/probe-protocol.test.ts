import { describe, expect, it } from "vitest";
import {
  classifyProbeResponse,
  verifyProbeDistinguishability,
  type DistinguishableProbeSpec,
  type MisconceptionHypothesis,
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

  it("requires competing hypotheses, unique model ids and complete identity", () => {
    expect(verifyProbeDistinguishability(spec(3, [])).issues).toEqual(["no_competing_hypotheses"]);
    expect(verifyProbeDistinguishability(spec(3, [H_ADD, H_ADD])).issues).toContain("duplicate_model_id");
    expect(verifyProbeDistinguishability(spec(3, [H_ADD], { requirementKey: "" })).issues).toEqual(["probe_identity_incomplete"]);
  });

  it("treats throwing or nondeterministic simulators as unverifiable", () => {
    const throwing = hypothesis("H_THROWS", () => { throw new Error("boom"); });
    expect(verifyProbeDistinguishability(spec(3, [H_ADD, throwing]))).toMatchObject({
      distinguishable: false, issues: ["prediction_failed"] });
    let calls = 0;
    const flaky = hypothesis("H_FLAKY", x => x + (calls++ % 2));
    expect(verifyProbeDistinguishability(spec(3, [H_ADD, flaky])).issues).toEqual(["nondeterministic_prediction"]);
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
});
