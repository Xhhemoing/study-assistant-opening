import { describe, expect, it } from "vitest";
import { createCapabilityRegistry, listModelCapabilities } from "../capability";
import {
  STANDARD_CAPABILITIES,
  V3_CAPABILITIES,
  createV3CapabilityRegistry,
  dsPointerStepCapability,
  functionDiffPlotCapability,
  proposalDiffCapability,
  subspaceRowTraceCapability,
} from ".";
import { decideBlock } from "../decide";

describe("rule witness and proposal capabilities", () => {
  it("keeps STANDARD_CAPABILITIES untouched while exposing V3_CAPABILITIES", () => {
    expect(STANDARD_CAPABILITIES.map((capability) => capability.id)).toEqual([
      "flow-diagram@1",
      "comparison-bars@1",
    ]);
    expect(V3_CAPABILITIES.map((capability) => capability.id)).toContain(proposalDiffCapability.id);
    expect(V3_CAPABILITIES.map((capability) => capability.id)).toContain(functionDiffPlotCapability.id);
  });

  it("hides host-only proposal diffs from model capability lists", () => {
    const registry = createV3CapabilityRegistry();
    expect(proposalDiffCapability.hostOnly).toBe(true);
    expect(proposalDiffCapability.aiCandidateOnly).toBe(true);
    expect(registry.get(proposalDiffCapability.id)).toBeDefined();
    expect(listModelCapabilities(registry).some((capability) => capability.id === proposalDiffCapability.id)).toBe(false);
    expect(listModelCapabilities(registry).some((capability) => capability.id === functionDiffPlotCapability.id)).toBe(true);
    expect(listModelCapabilities(registry).some((capability) => capability.id === subspaceRowTraceCapability.id)).toBe(true);
  });

  it("requires rule provenance, rejects actions and oversized payloads, and provides text fallbacks", () => {
    const registry = createCapabilityRegistry([dsPointerStepCapability, proposalDiffCapability]);
    const decision = decideBlock(
      {
        id: "w",
        capability: dsPointerStepCapability.id,
        allowedActions: [],
        limits: [],
        sourceRefs: [],
        params: {
          origin: "rules",
          allowedActions: [],
          title: "反转",
          before: [{ id: "A", next: "B" }],
          after: [{ id: "A", next: null }],
          severed: ["A.next"],
          dangling: [],
          explanation: "丢失 B",
        },
      },
      registry,
    );
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.text).toContain("断链");

    const illegalAction = decideBlock(
      {
        id: "w-act",
        capability: dsPointerStepCapability.id,
        allowedActions: ["mutate"],
        limits: [],
        sourceRefs: [],
        params: { origin: "rules", allowedActions: [], title: "t", before: [], after: [], explanation: "x" },
      },
      registry,
    );
    expect(illegalAction).toMatchObject({ ok: false, reason: "illegal_action" });

    const invalid = dsPointerStepCapability.params.safeParse({
      origin: "model",
      allowedActions: [],
      title: "x",
      before: [],
      after: [],
      explanation: "x",
    });
    expect(invalid.success).toBe(false);

    const oversized = functionDiffPlotCapability.params.safeParse({
      origin: "rules",
      allowedActions: [],
      title: "oversized",
      points: [{ x: "1", kind: "discontinuity" }],
      explanation: "a".repeat(12000),
    });
    expect(oversized.success).toBe(true);

    const tooLargeProposal = proposalDiffCapability.params.safeParse({
      aiCandidateOnly: true,
      title: "large",
      revisions: Array.from({ length: 6 }, (_, i) => ({
        path: `doc-${i}.md`,
        before: "b".repeat(5000),
        after: "a".repeat(5000),
        kind: "note" as const,
      })),
      undo: { token: "tok", compensates: [] },
    });
    expect(tooLargeProposal.success).toBe(false);
  });
});
