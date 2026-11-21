import { describe, expect, it } from "vitest";
import { createCapabilityRegistry, listModelCapabilities } from "../capability";
import { STANDARD_CAPABILITIES, dsPointerStepCapability, proposalDiffCapability, functionDiffPlotCapability } from ".";
import { decideBlock } from "../decide";

describe("rule witness and proposal capabilities", () => {
  it("hides host-only proposal diffs from model capability lists", () => {
    const registry = createCapabilityRegistry(STANDARD_CAPABILITIES);
    expect(registry.get(proposalDiffCapability.id)).toBeDefined();
    expect(listModelCapabilities(registry).some((capability) => capability.id === proposalDiffCapability.id)).toBe(false);
    expect(listModelCapabilities(registry).some((capability) => capability.id === functionDiffPlotCapability.id)).toBe(true);
  });
  it("requires rule provenance and gives a text fallback", () => {
    const registry = createCapabilityRegistry([dsPointerStepCapability]);
    const decision = decideBlock({ id: "w", capability: dsPointerStepCapability.id, allowedActions: [], limits: [], sourceRefs: [], params: { origin: "rules", allowedActions: [], title: "反转", before: [{ id: "A", next: "B" }], after: [{ id: "A", next: null }], severed: ["A.next"], dangling: [], explanation: "丢失 B" } }, registry);
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.text).toContain("断链");
    const invalid = dsPointerStepCapability.params.safeParse({ origin: "model", allowedActions: [], title: "x", before: [], after: [], explanation: "x" });
    expect(invalid.success).toBe(false);
  });
});
