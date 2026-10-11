import { describe, expect, it } from "vitest";
import {
  assertActivityCompleteDoesNotUpgradeMastery,
  assertNoUnevidencedIndependence,
  assertNoUnevidencedRead,
  classifyTutorHelpKind,
  exposuresAffectingItemAssistance,
  mapPmUnknownOutcome,
  readHelpExposureKind,
} from "./teaching-exposure";

describe("classifyTutorHelpKind", () => {
  it("maps explain without problem to instruction", () => {
    expect(classifyTutorHelpKind({ mode: "explain", problemId: null })).toBe("instruction");
  });

  it("maps hint with attempt to hint", () => {
    expect(classifyTutorHelpKind({
      mode: "hint",
      attemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      problemId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
    })).toBe("hint");
  });

  it("maps solution intent to solution", () => {
    expect(classifyTutorHelpKind({
      mode: "explain",
      problemId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
      intent: "solution",
    })).toBe("solution");
  });
});

describe("exposuresAffectingItemAssistance", () => {
  it("filters instruction kind and defaults missing kind to hint", () => {
    const kept = exposuresAffectingItemAssistance([
      { kind: "instruction", level: "revealed" },
      { kind: "hint", level: "hinted" },
      { kind: "solution", level: "revealed" },
      { level: "hinted" },
    ]);
    expect(kept.map((row) => row.kind ?? "missing")).toEqual(["hint", "solution", "missing"]);
  });
});

describe("readHelpExposureKind", () => {
  it("defaults legacy missing kind to hint", () => {
    expect(readHelpExposureKind(undefined)).toBe("hint");
    expect(readHelpExposureKind(null)).toBe("hint");
    expect(readHelpExposureKind("weird")).toBe("hint");
  });
});

describe("mapPmUnknownOutcome", () => {
  it("aliases PM unknown to wire unverified", () => {
    expect(mapPmUnknownOutcome()).toBe("unverified");
  });
});

describe("assertNoUnevidencedIndependence / Read", () => {
  it("rejects independent without problemId or with item help", () => {
    expect(() => assertNoUnevidencedIndependence("independent", { problemId: null })).toThrow(/problem id/);
    expect(() => assertNoUnevidencedIndependence("independent", {
      problemId: "p", deliveredItemHelp: true,
    })).toThrow(/item help/);
  });

  it("rejects read without delivered evidence", () => {
    expect(() => assertNoUnevidencedRead("read", { delivered: false })).toThrow(/delivered/);
    expect(() => assertNoUnevidencedRead("read", { delivered: true })).not.toThrow();
  });
});

describe("assertActivityCompleteDoesNotUpgradeMastery", () => {
  it("forbids SkillEvidence / outcome rewrite / force independent", () => {
    expect(() => assertActivityCompleteDoesNotUpgradeMastery({})).not.toThrow();
    expect(() => assertActivityCompleteDoesNotUpgradeMastery({ skillEvidenceLink: true }))
      .toThrow(/SkillEvidence/);
    expect(() => assertActivityCompleteDoesNotUpgradeMastery({ observationOutcomeRewrite: true }))
      .toThrow(/rewrite/);
    expect(() => assertActivityCompleteDoesNotUpgradeMastery({ summaryForceIndependent: true }))
      .toThrow(/observed_independent/);
  });
});
