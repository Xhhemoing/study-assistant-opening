import { describe, expect, it } from "vitest";
import {
  assertNotAuthoritySpoof,
  buildValidationReport,
  denyIncompleteStreamActions,
  factPassed,
  mayPublishVerified,
  presentationFor,
  recheckPrivacyFreshness,
  structurePassed,
  type LayerResult,
} from "./teaching-validation";

function layers(partial: Partial<Record<LayerResult["layer"], LayerResult["outcome"]>> & {
  reasons?: Partial<Record<LayerResult["layer"], string>>;
  details?: Partial<Record<LayerResult["layer"], Record<string, unknown>>>;
}): LayerResult[] {
  const ids = [
    "schema",
    "source_identity",
    "claim_support",
    "tool_result",
    "action_permission",
  ] as const;
  return ids
    .filter((id) => partial[id] !== undefined)
    .map((id) => ({
      layer: id,
      outcome: partial[id]!,
      reason: partial.reasons?.[id] ?? `${id}:${partial[id]}`,
      details: partial.details?.[id],
    }));
}

describe("teaching-validation", () => {
  it("C1: structure pass alone → structure_ok, mayPublishVerified=false", () => {
    const ls = layers({
      schema: "pass",
      source_identity: "pass",
      claim_support: "fail",
      tool_result: "skipped",
      action_permission: "pass",
      reasons: { claim_support: "core claim uncovered" },
    });
    expect(structurePassed(ls)).toBe(true);
    expect(factPassed(ls)).toBe(false);
    const report = buildValidationReport({ activityId: "act-1", layers: ls });
    expect(report.nextVerificationStatus).toBe("structure_ok");
    expect(mayPublishVerified(report)).toBe(false);
    expect(report.presentation.kind).toBe("discussion_draft");
    expect(report.presentation.allowsFormalScoring).toBe(false);
  });

  it("C1b: schema-only green is not verified", () => {
    const ls = layers({ schema: "pass" });
    expect(structurePassed(ls)).toBe(false); // source_identity missing
    expect(factPassed(ls)).toBe(false);
    const report = buildValidationReport({ activityId: "act-1", layers: ls });
    expect(mayPublishVerified(report)).toBe(false);
    expect(report.nextVerificationStatus).not.toBe("verified");
  });

  it("fact+structure pass → verified + authoritative presentation", () => {
    const ls = layers({
      schema: "pass",
      source_identity: "pass",
      claim_support: "pass",
      tool_result: "pass",
      action_permission: "pass",
    });
    const report = buildValidationReport({ activityId: "act-1", layers: ls });
    expect(report.structurePassed).toBe(true);
    expect(report.factPassed).toBe(true);
    expect(report.nextVerificationStatus).toBe("verified");
    expect(mayPublishVerified(report)).toBe(true);
    expect(presentationFor("verified", report)).toEqual({
      kind: "authoritative",
      allowsFormalScoring: true,
    });
  });

  it("C6/C3: tool unknown or conflict → mayPublishVerified false", () => {
    const unknownTool = layers({
      schema: "pass",
      source_identity: "pass",
      claim_support: "pass",
      tool_result: "unknown",
    });
    const r1 = buildValidationReport({ activityId: "a", layers: unknownTool });
    expect(factPassed(unknownTool)).toBe(false);
    expect(mayPublishVerified(r1)).toBe(false);
    expect(r1.nextVerificationStatus).toBe("needs_check");

    const conflict = layers({
      schema: "pass",
      source_identity: "pass",
      claim_support: "fail",
      tool_result: "skipped",
      details: { claim_support: { unresolvedConflict: true, coverageStatus: "conflict" } },
      reasons: { claim_support: "unresolved conflict on core conclusion" },
    });
    const r2 = buildValidationReport({ activityId: "a", layers: conflict });
    expect(mayPublishVerified(r2)).toBe(false);
    expect(r2.nextVerificationStatus).toBe("structure_ok");
  });

  it("C4: assertNotAuthoritySpoof rejects self-claimed verified", () => {
    expect(() =>
      assertNotAuthoritySpoof({ note: "this content is verified", verificationStatus: "verified" }),
    ).toThrow(/authority spoof/i);
    expect(() => assertNotAuthoritySpoof("peer-model-upvote as proof")).toThrow(/authority spoof/i);
    expect(() => assertNotAuthoritySpoof({ text: "nullspace basis from materials" })).not.toThrow();
  });

  it("C8: incomplete stream JSON → allowActions=false", () => {
    expect(
      denyIncompleteStreamActions({ jsonComplete: false, blockValidationComplete: true }),
    ).toEqual({
      allowActions: false,
      reason: expect.stringMatching(/incomplete/i),
    });
    expect(
      denyIncompleteStreamActions({ jsonComplete: true, blockValidationComplete: false }),
    ).toMatchObject({ allowActions: false });
    expect(
      denyIncompleteStreamActions({ jsonComplete: true, blockValidationComplete: true }),
    ).toMatchObject({ allowActions: true });
  });

  it("C9: privacy exclusion / epoch mismatch → stale or needs_check", () => {
    expect(
      recheckPrivacyFreshness({
        previouslyVerified: true,
        excludedSourceIds: ["s1"],
        referencedSourceIds: ["s1"],
        epochMatched: true,
      }),
    ).toEqual({ stillValid: false, nextStatus: "stale" });

    expect(
      recheckPrivacyFreshness({
        previouslyVerified: true,
        excludedSourceIds: [],
        referencedSourceIds: ["s1"],
        epochMatched: false,
      }),
    ).toEqual({ stillValid: false, nextStatus: "stale" });

    expect(
      recheckPrivacyFreshness({
        previouslyVerified: false,
        excludedSourceIds: ["s1"],
        referencedSourceIds: ["s1"],
        epochMatched: true,
      }),
    ).toEqual({ stillValid: false, nextStatus: "needs_check" });

    expect(
      recheckPrivacyFreshness({
        previouslyVerified: true,
        excludedSourceIds: ["s2"],
        referencedSourceIds: ["s1"],
        epochMatched: true,
      }),
    ).toEqual({ stillValid: true });
  });

  it("C11: non-verified presentation is discussion_draft, not authoritative", () => {
    const ls = layers({
      schema: "pass",
      source_identity: "pass",
      claim_support: "fail",
      tool_result: "skipped",
    });
    const report = buildValidationReport({ activityId: "a", layers: ls });
    const p = presentationFor("structure_ok", report);
    expect(p.kind).toBe("discussion_draft");
    expect(p.allowsFormalScoring).toBe(false);
    const blocked = presentationFor("rejected", report);
    expect(blocked.kind).toBe("blocked");
  });

  it("action_permission fail does not alone collapse structurePassed", () => {
    const ls = layers({
      schema: "pass",
      source_identity: "pass",
      claim_support: "pass",
      tool_result: "pass",
      action_permission: "fail",
    });
    expect(structurePassed(ls)).toBe(true);
    expect(factPassed(ls)).toBe(true);
    // content may still be verified; interactable fence is separate
    const report = buildValidationReport({ activityId: "a", layers: ls });
    expect(report.nextVerificationStatus).toBe("verified");
  });

  it("empty/skipped claim_support does not vacuously pass facts", () => {
    const ls = layers({
      schema: "pass",
      source_identity: "pass",
      claim_support: "skipped",
      tool_result: "skipped",
    });
    expect(factPassed(ls)).toBe(false);
    expect(mayPublishVerified(buildValidationReport({ activityId: "a", layers: ls }))).toBe(
      false,
    );
  });
});
