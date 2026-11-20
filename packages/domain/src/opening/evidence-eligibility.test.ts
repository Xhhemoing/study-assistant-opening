import { describe, expect, it, vi } from "vitest";
import { createCartridgeRegistry } from "./cartridges/registry";
import { evaluateEvidenceEligibility, gateObservationCartridgeEvidence, type CartridgeEvidenceInput } from "./evidence-eligibility";
import { observation, context, exposure, withHelp } from "./evidence-eligibility-fixtures";

describe("evaluateEvidenceEligibility", () => {
  it("qualifies a complete, independently attempted, reference-checked delayed answer", () => {
    expect(evaluateEvidenceEligibility(observation, context)).toMatchObject({
      independentAttempt: "yes",
      verifiedCorrect: "yes",
      usableForCurrentVersion: "yes",
      usableForDelayedCheck: "yes",
      policyVersion: expect.any(String),
    });
  });

  it.each(["attemptId", "problemId", "itemVersionId"] as const)(
    "does not promote a legacy observation missing %s",
    (field) => {
      const result = evaluateEvidenceEligibility({ ...observation, [field]: null }, context);
      expect(result).toMatchObject({
        independentAttempt: "unknown",
        verifiedCorrect: "unknown",
        usableForCurrentVersion: "unknown",
        usableForDelayedCheck: "unknown",
      });
      expect(result.reasonCodes).toContain("observation_identity_incomplete");
    },
  );

  it("returns the same ordered, deduplicated reasons without mutating its inputs", () => {
    const exposures = [exposure, { ...exposure, deliveredAt: null }, exposure];
    const ctx = withHelp(exposures);
    const before = JSON.stringify({ observation, ctx });
    const first = evaluateEvidenceEligibility(observation, ctx);
    const second = evaluateEvidenceEligibility(observation, withHelp([...exposures].reverse()));
    expect(first).toEqual(second);
    expect(new Set(first.reasonCodes).size).toBe(first.reasonCodes.length);
    expect(JSON.stringify({ observation, ctx })).toBe(before);
  });
});

describe("gateObservationCartridgeEvidence", () => {
  it.each(["constructor", "toString", "__proto__"])("ignores the inherited emission with observation ID %s", observationId => {
    const eligibility = evaluateEvidenceEligibility(observation, context);
    const input = { registry: createCartridgeRegistry(), emissions: {} };
    const result = gateObservationCartridgeEvidence(eligibility, observationId, observation, input);
    expect(result.eligibility).toBe(eligibility);
    expect(result.qualification).toBeNull();
  });

  const eligibility = evaluateEvidenceEligibility(observation, context);
  const inputFor = (fields: object) => ({ registry: createCartridgeRegistry(), ...fields }) as CartridgeEvidenceInput;

  it.each([{}, { emissions: undefined }, { emissions: { other: null } }, { emissions: Object.create(null) }])(
    "preserves eligibility when no matching emission was recorded (%j)", fields => {
      const result = gateObservationCartridgeEvidence(eligibility, "obs", observation, inputFor(fields));
      expect(result).toEqual({ eligibility, qualification: null });
    },
  );

  it.each([["obs", null], ["obs", undefined], ["obs", 42], ["constructor", null]] as const)(
    "withholds eligibility for an own %s emission with value %s", (id, value) => {
      const result = gateObservationCartridgeEvidence(eligibility, id, observation, inputFor({ emissions: { [id]: value } }));
      expect(result).toMatchObject({
        qualification: { qualified: false },
        eligibility: { verifiedCorrect: "unknown", usableForDelayedCheck: "unknown" },
      });
    },
  );

  it.each(["map getter", "entry getter", "map Proxy", "input Proxy"] as const)(
    "withholds eligibility without invoking the %s", kind => {
      const read = vi.fn(() => undefined);
      const trap = vi.fn((): never => { throw new Error("Unexpected Proxy trap"); });
      const handler = { get: trap, getOwnPropertyDescriptor: trap, getPrototypeOf: trap };
      const input = inputFor({ emissions: {} });
      if (kind === "map getter") Object.defineProperty(input, "emissions", { get: read });
      if (kind === "entry getter") Object.defineProperty(input.emissions, "obs", { get: read, enumerable: true });
      if (kind === "map Proxy") input.emissions = new Proxy({}, handler);
      const candidate = kind === "input Proxy" ? new Proxy(input, handler) : input;
      const result = gateObservationCartridgeEvidence(eligibility, "obs", observation, candidate);
      expect(result).toMatchObject({
        qualification: { qualified: false },
        eligibility: { verifiedCorrect: "unknown", usableForDelayedCheck: "unknown" },
      });
      expect(read).not.toHaveBeenCalled();
      expect(trap).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["null", null], ["primitive", 42], ["array", []], ["custom prototype", Object.create({ obs: null })],
  ])("withholds eligibility for a malformed %s emission map", (_kind, emissions) => {
    const result = gateObservationCartridgeEvidence(eligibility, "obs", observation, inputFor({ emissions }));
    expect(result).toMatchObject({
      qualification: { qualified: false },
      eligibility: { verifiedCorrect: "unknown", usableForDelayedCheck: "unknown" },
    });
  });
});
