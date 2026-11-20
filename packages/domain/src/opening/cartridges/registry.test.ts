import { describe, expect, it } from "vitest";
import {
  CartridgeRegistrationError,
  createCartridgeRegistry,
  getCartridge,
  listCartridgesByCapability,
  registerCartridge,
  validateCartridge,
} from "./registry";
import { createStackFeasibilityProbe, stack408Cartridge } from "./stack-408-v1";
import {
  hasEvidenceCapability,
  hasMaterialReactiveCapability,
  hasSchedulableCapability,
  meetsCapabilityLevel,
  type ContinuityCartridge,
} from "./types";

const continuityOnly: ContinuityCartridge<{ step: number }> = {
  manifest: { id: "demo.notes.v1", version: "0.1.0", domain: "demo", title: "笔记续接", level: "L1_CONTINUITY" },
  serializeContinuityState: state => JSON.stringify(state),
  parseContinuityState: raw => typeof raw === "object" && raw !== null && typeof (raw as { step?: unknown }).step === "number"
    ? { ok: true, value: raw as { step: number } } : { ok: false, issues: ["step required"] },
  buildResumeSummary: state => ({ cartridgeId: "demo.notes.v1", cartridgeVersion: "0.1.0", headline: `第 ${state.step} 步`,
    completedSteps: state.step, totalSteps: null, nextRequirementKey: null }),
};

const asLevel = (level: "L2_SCHEDULABLE" | "L3_MATERIAL_REACTIVE", id: string) =>
  ({ ...stack408Cartridge, manifest: { ...stack408Cartridge.manifest, id, level } });

describe("capability levels and guards", () => {
  it("orders levels progressively", () => {
    expect(meetsCapabilityLevel("L4_EVIDENCE", "L2_SCHEDULABLE")).toBe(true);
    expect(meetsCapabilityLevel("L2_SCHEDULABLE", "L3_MATERIAL_REACTIVE")).toBe(false);
  });

  it("narrows only when the manifest declares the level and the methods exist", () => {
    expect(hasSchedulableCapability(continuityOnly)).toBe(false);
    expect(hasEvidenceCapability(stack408Cartridge)).toBe(true);
    const l3 = asLevel("L3_MATERIAL_REACTIVE", "408.stack.l3");
    expect(hasMaterialReactiveCapability(l3)).toBe(true);
    // Methods alone do not grant evidence capability: the declared level governs.
    expect(hasEvidenceCapability(l3)).toBe(false);
  });
});

describe("CartridgeRegistry", () => {
  it("registers cartridges and lists them by minimum capability", () => {
    const registry = createCartridgeRegistry([continuityOnly, stack408Cartridge]);
    const l2 = asLevel("L2_SCHEDULABLE", "408.stack.l2");
    expect(registerCartridge(registry, l2)).toMatchObject({ ok: true, manifest: { id: "408.stack.l2" } });
    expect(getCartridge(registry, "408.stack.v1")).toBe(stack408Cartridge);
    expect(getCartridge(registry, "missing")).toBeNull();
    expect(registry.listCartridges().map(row => row.manifest.id)).toEqual(["408.stack.l2", "408.stack.v1", "demo.notes.v1"]);
    expect(listCartridgesByCapability(registry, "L2_SCHEDULABLE").map(row => row.manifest.id)).toEqual(["408.stack.l2", "408.stack.v1"]);
    expect(listCartridgesByCapability(registry, "L4_EVIDENCE").map(row => row.manifest.id)).toEqual(["408.stack.v1"]);
  });

  it("rejects duplicate ids and invalid manifests", () => {
    const registry = createCartridgeRegistry([stack408Cartridge]);
    expect(registry.registerCartridge(stack408Cartridge)).toMatchObject({ ok: false, issues: [{ code: "duplicate_cartridge_id" }] });
    const bad = registry.registerCartridge({ ...continuityOnly, manifest: { ...continuityOnly.manifest, version: "v1", extra: true } });
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.issues.every(issue => issue.code === "manifest_invalid")).toBe(true);
    expect(registry.registerCartridge(null)).toMatchObject({ ok: false, issues: [{ code: "cartridge_not_object" }] });
  });

  it("rejects a declared level whose capability methods are missing", () => {
    const report = validateCartridge({ ...continuityOnly, manifest: { ...continuityOnly.manifest, level: "L3_MATERIAL_REACTIVE" } });
    expect(report.ok).toBe(false);
    expect(!report.ok && report.issues.map(issue => issue.detail)).toEqual([
      "L3_MATERIAL_REACTIVE requires projectTaskCandidates()",
      "L3_MATERIAL_REACTIVE requires bindMaterialChunks()",
      "L3_MATERIAL_REACTIVE requires extractExerciseSeeds()",
    ]);
  });

  it("refuses an L4 cartridge without probes or evidence contract", () => {
    const report = validateCartridge({ ...stack408Cartridge, evidenceContract: { evaluatorVersion: "", specVersion: "" }, listProbes: () => [] });
    expect(!report.ok && report.issues.map(issue => issue.code)).toEqual(["evidence_contract_missing", "evidence_probes_missing"]);
  });

  it("refuses an L4 cartridge carrying a degenerate probe", () => {
    // 3,2,1 is feasible for a real stack and for the bypass misconception alike.
    const degenerate = createStackFeasibilityProbe("408.stack.degenerate", { pushOrder: [1, 2, 3], candidatePops: [3, 2, 1] }, "判断");
    const probes = [...stack408Cartridge.listProbes(), degenerate];
    const candidate = { ...stack408Cartridge, manifest: { ...stack408Cartridge.manifest, id: "408.stack.bad" },
      listProbes: () => probes, getProbe: (id: string) => probes.find(probe => probe.probeId === id) ?? null };
    const report = validateCartridge(candidate);
    expect(report.ok).toBe(false);
    expect(!report.ok && report.issues).toEqual([{ code: "evidence_probe_not_distinguishable",
      detail: "408.stack.degenerate: ambiguous_hypothesis_pair, degenerate_against_correct_model" }]);
    expect(report.probeReports.at(-1)?.ambiguousPairs).toEqual([{ a: "H_FIFO_QUEUE_CONFUSION", b: "H_TOP_POINTER_OFF_BY_ONE",
      observableKey: JSON.stringify(["feasibility", "infeasible", 0]) }]);
    expect(report.probeReports.at(-1)?.degenerateAgainstCorrectModel).toEqual([
      { hypothesisId: "H_BYPASS_LIFO_ORDER", observableKey: JSON.stringify(["feasibility", "feasible", null]) }]);
    expect(() => createCartridgeRegistry([candidate])).toThrow(CartridgeRegistrationError);
  });

  it("refuses duplicate probe ids and getProbe inconsistencies", () => {
    const [first] = stack408Cartridge.listProbes();
    const report = validateCartridge({ ...stack408Cartridge, listProbes: () => [first!, first!], getProbe: () => null });
    expect(!report.ok && report.issues.map(issue => issue.code)).toEqual([
      "evidence_probe_lookup_mismatch", "evidence_probe_id_duplicate", "evidence_probe_lookup_mismatch"]);
  });
});
