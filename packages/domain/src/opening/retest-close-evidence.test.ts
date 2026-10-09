import { describe, expect, it } from "vitest";
import {
  RETEST_CLOSE_DEFAULT_DIMENSION,
  nextTutorKindAfterRetestClose,
  nodeIdForSkillLabel,
  prepareRetestSkillLink,
  shouldAppendRetestEvidence,
} from "./retest-close-evidence";

const NODE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const RETEST = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";

describe("shouldAppendRetestEvidence", () => {
  it("allows only independent correct", () => {
    expect(
      shouldAppendRetestEvidence({ assistance: "independent", outcome: "correct" }),
    ).toBe(true);
    expect(
      shouldAppendRetestEvidence({ assistance: "hinted", outcome: "correct" }),
    ).toBe(false);
    expect(
      shouldAppendRetestEvidence({ assistance: "revealed", outcome: "correct" }),
    ).toBe(false);
    expect(
      shouldAppendRetestEvidence({ assistance: "independent", outcome: "unverified" }),
    ).toBe(false);
    expect(
      shouldAppendRetestEvidence({ assistance: "independent", outcome: "incorrect" }),
    ).toBe(false);
  });
});

describe("prepareRetestSkillLink", () => {
  const snapshot = { nodes: [{ id: NODE, label: "chain rule" }] };

  it("returns null without retestId", () => {
    expect(
      prepareRetestSkillLink({
        assistance: "independent",
        outcome: "correct",
        skillLabel: "chain rule",
        snapshot,
      }),
    ).toBeNull();
  });

  it("returns null when assisted success must not upgrade mastery", () => {
    expect(
      prepareRetestSkillLink({
        retestId: RETEST,
        assistance: "revealed",
        outcome: "correct",
        skillLabel: "chain rule",
        snapshot,
      }),
    ).toBeNull();
  });

  it("resolves nodeId from snapshot by exact skillLabel and defaults dimension to transfer", () => {
    expect(
      prepareRetestSkillLink({
        retestId: RETEST,
        assistance: "independent",
        outcome: "correct",
        skillLabel: "chain rule",
        snapshot,
      }),
    ).toEqual({ nodeId: NODE, dimension: RETEST_CLOSE_DEFAULT_DIMENSION });
  });

  it("prefers explicit nodeId and dimension", () => {
    expect(
      prepareRetestSkillLink({
        retestId: RETEST,
        assistance: "independent",
        outcome: "correct",
        skillLabel: "other",
        nodeId: NODE,
        dimension: "timed",
        snapshot: null,
      }),
    ).toEqual({ nodeId: NODE, dimension: "timed" });
  });

  it("returns null when no node can be resolved", () => {
    expect(
      prepareRetestSkillLink({
        retestId: RETEST,
        assistance: "independent",
        outcome: "correct",
        skillLabel: "missing",
        snapshot,
      }),
    ).toBeNull();
  });
});

describe("nodeIdForSkillLabel", () => {
  it("matches exact label only", () => {
    expect(nodeIdForSkillLabel({ nodes: [{ id: NODE, label: "chain rule" }] }, "chain rule")).toBe(
      NODE,
    );
    expect(nodeIdForSkillLabel({ nodes: [{ id: NODE, label: "limits" }] }, "chain rule")).toBeNull();
    expect(nodeIdForSkillLabel(null, "chain rule")).toBeNull();
  });
});

describe("nextTutorKindAfterRetestClose", () => {
  it("recommends independent_variant without mastery fields", () => {
    expect(nextTutorKindAfterRetestClose(NODE)).toBe("independent_variant");
  });
});
