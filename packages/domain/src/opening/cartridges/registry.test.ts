import { describe, expect, it } from "vitest";
import { qualifyCartridgeEmission } from "./evidence-gate";
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
  safeErrorDetail,
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
    expect(getCartridge(registry, "408.stack.v1")?.manifest).toEqual(stack408Cartridge.manifest);
    expect(getCartridge(registry, "missing")).toBeNull();
    expect(registry.listCartridges().map(row => row.manifest.id)).toEqual(["408.stack.l2", "408.stack.v1", "demo.notes.v1"]);
    expect(listCartridgesByCapability(registry, "L2_SCHEDULABLE").map(row => row.manifest.id)).toEqual(["408.stack.l2", "408.stack.v1"]);
    expect(listCartridgesByCapability(registry, "L4_EVIDENCE").map(row => row.manifest.id)).toEqual(["408.stack.v1"]);
  });

  it("uses the immutable validated manifest for identity, capability, and evidence qualification", () => {
    const original = { ...stack408Cartridge.manifest, id: "alpha.v1", version: "1.0.0" };
    const candidate = { ...stack408Cartridge, manifest: { ...original } };
    const registry = createCartridgeRegistry();
    const report = registry.registerCartridge(candidate);
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    Reflect.set(report.manifest, "version", "9.0.0");
    candidate.manifest.id = "beta.v1";
    candidate.manifest.version = "2.0.0";

    const registered = registry.getCartridge("alpha.v1")!;
    const emission = {
      cartridgeId: "alpha.v1",
      cartridgeVersion: "1.0.0",
      probeId: "408.stack.trace.interleaved-underflow.v1",
      response: { outputs: "2,3,1,UNDERFLOW", finalTop: -1 },
    };
    expect(qualifyCartridgeEmission(registry, { ...emission, cartridgeVersion: "2.0.0" })).toMatchObject({
      qualified: false, reasonCodes: ["cartridge_version_mismatch"],
    });
    candidate.manifest = { ...candidate.manifest, level: "L1_CONTINUITY" };
    Object.defineProperty(candidate, "manifest", { get() { throw new Error("manifest re-read after registration"); } });
    expect(registered.manifest).toEqual(original);
    expect(Object.isFrozen(registered.manifest)).toBe(true);
    expect(registry.getCartridge("beta.v1")).toBeNull();
    expect(registry.listCartridges()).toEqual([registered]);
    expect(registry.listCartridgesByCapability("L4_EVIDENCE")).toEqual([registered]);
    expect(hasEvidenceCapability(registered)).toBe(true);
    expect(qualifyCartridgeEmission(registry, emission)).toMatchObject({ qualified: true });
  });

  it("rejects a manifest whose field getter throws during schema parsing", () => {
    const candidate = {
      ...continuityOnly,
      manifest: { ...continuityOnly.manifest, get version(): string { throw new Error("version unavailable"); } },
    };
    const registry = createCartridgeRegistry();
    expect(registry.registerCartridge(candidate)).toMatchObject({
      ok: false, issues: [{ code: "manifest_invalid", detail: "version unavailable" }],
    });
    expect(registry.listCartridges()).toEqual([]);
  });

  it("validates and restores unknown state before building a registered cartridge's resume summary", () => {
    const candidate = {
      ...continuityOnly,
      parseContinuityState(raw: unknown) {
        if (raw === "stored") return { ok: true as const, value: { step: 2 } };
        if (raw === "throws") throw new Error("could not restore state");
        return continuityOnly.parseContinuityState(raw);
      },
    };
    const registry = createCartridgeRegistry([candidate, stack408Cartridge]);
    const continuity = getCartridge(registry, "demo.notes.v1")!;
    expect(continuity.buildResumeSummary("stored")).toMatchObject({ completedSteps: 2 });
    for (const [raw, issue] of [[{}, "step required"], ["throws", "could not restore state"]] as const) {
      expect(() => continuity.buildResumeSummary(raw)).toThrow(expect.objectContaining({
        name: "CartridgeContinuityStateError", issues: [issue],
      }));
    }
    expect(() => getCartridge(registry, "408.stack.v1")!.buildResumeSummary({})).toThrow(expect.objectContaining({
      name: "CartridgeContinuityStateError", issues: expect.any(Array),
    }));
  });

  it.each(["evaluatorVersion", "specVersion"] as const)("requires a readable non-blank string for %s", field => {
    const registry = createCartridgeRegistry();
    for (const value of [true, 1, {}, " \t\n"]) {
      const candidate = { ...stack408Cartridge, evidenceContract: { ...stack408Cartridge.evidenceContract, [field]: value } };
      expect(registry.registerCartridge(candidate)).toMatchObject({ ok: false, issues: [{ code: "evidence_contract_missing" }] });
      expect(hasEvidenceCapability(candidate)).toBe(false);
    }
    const evidenceContract = Object.defineProperty({ ...stack408Cartridge.evidenceContract }, field, {
      get() { throw new Error(`${field} read failed`); },
    });
    const candidate = { ...stack408Cartridge, evidenceContract };
    expect(registry.registerCartridge(candidate)).toMatchObject({
      ok: false, issues: [{ code: "evidence_contract_missing", detail: `${field} read failed` }],
    });
    expect(hasEvidenceCapability(candidate)).toBe(false);
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

  it("rejects a probe list whose element getter throws", () => {
    const probes = Object.defineProperty([], 0, {
      get() { throw new Error("probe element unavailable"); },
    });
    expect(validateCartridge({ ...stack408Cartridge, listProbes: () => probes })).toMatchObject({
      ok: false,
      issues: [{ code: "evidence_probe_listing_failed" }],
      probeReports: [],
    });
  });

  it("rejects a probe list with holes before validating any probes", () => {
    const probes = [...stack408Cartridge.listProbes()];
    probes.length += 1;
    expect(validateCartridge({ ...stack408Cartridge, listProbes: () => probes })).toMatchObject({
      ok: false,
      issues: [{ code: "evidence_probe_listing_failed" }],
      probeReports: [],
    });
  });

  it.each(["iterator", "named property", "accessor"] as const)("rejects a probe list with an own %s", field => {
    const [probe] = stack408Cartridge.listProbes();
    const probes = [probe!];
    if (field === "iterator") {
      Object.defineProperty(probes, Symbol.iterator, { value: function* () { yield probe; } });
    } else if (field === "named property") {
      Object.defineProperty(probes, "extra", { value: true });
    } else {
      Object.defineProperty(probes, "0", { get: () => probe });
    }
    const registry = createCartridgeRegistry();
    const candidate = { ...stack408Cartridge, listProbes: () => probes };

    expect(registry.registerCartridge(candidate)).toMatchObject({
      ok: false, issues: [{ code: "evidence_probe_listing_failed" }], probeReports: [],
    });
    expect(registry.getCartridge(candidate.manifest.id)).toBeNull();
  });

  it("validates all own probe elements even when a property read reports a shorter list", () => {
    const [first] = stack408Cartridge.listProbes();
    const invalid = { ...first!, probeId: "invalid", hypotheses: [] };
    const probes = new Proxy([first!, invalid], {
      get: (target, key) => key === "length" ? 1 : Reflect.get(target, key),
    });
    const registry = createCartridgeRegistry();
    const candidate = { ...stack408Cartridge, listProbes: () => probes, getProbe: (id: string) => id === "invalid" ? invalid : first! };

    expect(registry.registerCartridge(candidate)).toMatchObject({
      ok: false,
      issues: [{ code: "evidence_probe_not_distinguishable" }],
      probeReports: [{ distinguishable: true }, { probeId: "invalid", distinguishable: false }],
    });
    expect(registry.getCartridge(candidate.manifest.id)).toBeNull();
  });

  it("refuses an L4 cartridge when a hypothesis iterator hides an ambiguous pair", () => {
    const [first] = stack408Cartridge.listProbes();
    const [a, b] = first!.hypotheses;
    const hypotheses = [a!, b!, { ...a!, id: "H_DUPLICATE_PREDICTION" }];
    const probe = { ...first!, hypotheses };
    const candidate = {
      ...stack408Cartridge, listProbes: () => [probe], getProbe: () => probe,
    };
    expect(validateCartridge(candidate).probeReports[0]?.ambiguousPairs).toEqual([
      expect.objectContaining({ a: "H_DUPLICATE_PREDICTION", b: a!.id }),
    ]);
    Object.defineProperty(hypotheses, Symbol.iterator, {
      value: function* () { yield a; yield b; },
    });

    const registry = createCartridgeRegistry();
    expect(registry.registerCartridge(candidate)).toMatchObject({
      ok: false,
      issues: [{ code: "evidence_probe_not_distinguishable" }],
      probeReports: [{ distinguishable: false }],
    });
    expect(registry.getCartridge(candidate.manifest.id)).toBeNull();
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

  it("converts exceptions from getProbe and getters into structured registration rejections", () => {
    const throwingLookup = {
      ...stack408Cartridge,
      manifest: { ...stack408Cartridge.manifest, id: "408.stack.throwing-lookup" },
      getProbe: () => { throw new Error("lookup boom"); },
    };
    const report = validateCartridge(throwingLookup);
    expect(report.ok).toBe(false);
    expect(!report.ok && report.issues.every(issue => issue.code === "evidence_probe_lookup_failed")).toBe(true);
    expect(createCartridgeRegistry().registerCartridge(throwingLookup).ok).toBe(false);

    const throwingManifest = Object.defineProperty({}, "manifest", {
      get() { throw new Error("manifest boom"); },
      enumerable: true,
    });
    expect(validateCartridge(throwingManifest)).toMatchObject({
      ok: false,
      issues: [{ code: "manifest_invalid" }],
    });

    const [first] = stack408Cartridge.listProbes();
    const badEncoderProbe = { ...first!, observableKey: () => "   " };
    const badEncoderCartridge = {
      ...stack408Cartridge,
      manifest: { ...stack408Cartridge.manifest, id: "408.stack.blank-key" },
      listProbes: () => [badEncoderProbe],
      getProbe: (id: string) => id === badEncoderProbe.probeId ? badEncoderProbe : null,
    };
    const badEncoderReport = validateCartridge(badEncoderCartridge);
    expect(badEncoderReport.ok).toBe(false);
    expect(!badEncoderReport.ok && badEncoderReport.issues[0]?.code).toBe("evidence_probe_not_distinguishable");
    expect(badEncoderReport.probeReports[0]?.issues).toContain("invalid_observable_key");
  });

  it("handles unprintable thrown values (null-prototype and throwing Symbol.toPrimitive) without secondary crashes", () => {
    const nullProto = Object.create(null) as unknown;
    const throwingToPrimitive = {
      [Symbol.toPrimitive]() { throw new Error("boom"); },
    };
    const brokenError = Object.defineProperty(new Error("ignored"), "message", {
      get() { throw throwingToPrimitive; },
    });

    expect(safeErrorDetail(new Error("plain boom"))).toBe("plain boom");
    expect(safeErrorDetail(nullProto)).toBe("unprintable thrown value");
    expect(safeErrorDetail(throwingToPrimitive)).toBe("unprintable thrown value");
    expect(safeErrorDetail(brokenError)).toBe("unprintable thrown value");

    for (const weird of [nullProto, throwingToPrimitive]) {
      const badLookup = validateCartridge({
        ...stack408Cartridge,
        manifest: { ...stack408Cartridge.manifest, id: "408.stack.weird-lookup" },
        getProbe: () => { throw weird; },
      });
      expect(badLookup.ok).toBe(false);
      expect(!badLookup.ok && badLookup.issues.every(issue =>
        issue.code === "evidence_probe_lookup_failed" && issue.detail.includes("unprintable thrown value"))).toBe(true);

      const badList = validateCartridge({
        ...stack408Cartridge,
        manifest: { ...stack408Cartridge.manifest, id: "408.stack.weird-list" },
        listProbes: () => { throw weird; },
      });
      expect(badList).toMatchObject({
        ok: false,
        issues: [{ code: "evidence_probe_listing_failed", detail: "unprintable thrown value" }],
      });

      const badManifest = Object.defineProperty({}, "manifest", {
        get() { throw weird; },
        enumerable: true,
      });
      expect(validateCartridge(badManifest)).toMatchObject({
        ok: false,
        issues: [{ code: "manifest_invalid", detail: "unprintable thrown value" }],
      });
    }
  });
});
