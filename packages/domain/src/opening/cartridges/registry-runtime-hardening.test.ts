import { describe, expect, it } from "vitest";
import { qualifyCartridgeEmission } from "./evidence-gate";
import { createCartridgeRegistry } from "./registry";
import { stack408Cartridge } from "./stack-408-v1";
import type { DistinguishableProbeSpec } from "./probe-protocol";

type RuntimeProbe = DistinguishableProbeSpec<unknown, unknown>;

function createProbe(probeId = "registry.runtime-hardening.v1", exotic = false): RuntimeProbe {
  const input: Record<string, unknown> = {
    bigint: 1n,
    undefinedValue: undefined,
    nan: Number.NaN,
    positiveInfinity: Number.POSITIVE_INFINITY,
    negativeInfinity: Number.NEGATIVE_INFINITY,
    negativeZero: -0,
  };
  input.self = input;
  Object.defineProperty(input, "__proto__", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: { marker: "nested-own-proto" },
  });
  const probe: Record<string, unknown> = {
    probeId,
    requirementKey: "registry.runtime-hardening",
    prompt: "Choose the correct observable.",
    input: exotic ? input : 1,
    correctModel: {
      id: "correct",
      label: "Correct",
      role: "correct",
      predict: () => "correct",
    },
    hypotheses: [{
      id: "wrong",
      label: "Wrong",
      role: "misconception",
      description: "A wrong observable.",
      predict: () => "wrong",
    }],
    observableKey: (value: unknown) => typeof value === "string" ? value : String(value),
    parseResponse: (response: unknown) => typeof response === "string" ? response : null,
  };
  if (exotic) {
    Object.defineProperty(probe, "__proto__", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: { marker: "probe-own-proto" },
    });
  }
  return probe as unknown as RuntimeProbe;
}

function createCandidate(
  probe: RuntimeProbe,
  getProbe: (probeId: string) => RuntimeProbe | null,
) {
  return {
    ...stack408Cartridge,
    manifest: { ...stack408Cartridge.manifest, id: `registry.runtime-hardening.${probe.probeId}` },
    listProbes: () => [probe],
    getProbe,
    evaluateProbeResponse(probeId: string, response: unknown) {
      const correct = response === "correct";
      return {
        probeId,
        requirementKey: "registry.runtime-hardening",
        outcome: correct ? "correct" as const : "incorrect" as const,
        diagnosis: correct ? "correct_model" as const : "misconception" as const,
        matchedHypothesisId: correct ? null : "wrong",
        observableKey: typeof response === "string" ? response : null,
      };
    },
  };
}

describe("runtime cartridge probe hardening", () => {
  it("keeps exotic cloned data usable across listing, lookup, and qualification", () => {
    const probe = createProbe(undefined, true);
    const candidate = createCandidate(probe, () => probe);
    const registry = createCartridgeRegistry();
    expect(registry.registerCartridge(candidate)).toMatchObject({ ok: true });
    const registered = registry.getCartridge(candidate.manifest.id)!;

    const listed = registered.listProbes()[0]!;
    const lookedUp = registered.getProbe(probe.probeId)!;
    const input = listed.input as Record<string, unknown>;
    expect(Object.hasOwn(input, "undefinedValue")).toBe(true);
    expect(input.undefinedValue).toBeUndefined();
    expect(Number.isNaN(input.nan)).toBe(true);
    expect(Object.is(input.negativeZero, -0)).toBe(true);
    expect(input.positiveInfinity).toBe(Number.POSITIVE_INFINITY);
    expect(input.negativeInfinity).toBe(Number.NEGATIVE_INFINITY);
    expect(input.bigint).toBe(1n);
    expect(input.self).toBe(input);
    expect(Object.getOwnPropertyDescriptor(input, "__proto__")?.value).toEqual({ marker: "nested-own-proto" });
    expect(Object.getOwnPropertyDescriptor(listed, "__proto__")?.value).toEqual({ marker: "probe-own-proto" });
    expect(lookedUp.probeId).toBe(probe.probeId);

    expect(qualifyCartridgeEmission(
      registry,
      {
        cartridgeId: candidate.manifest.id,
        cartridgeVersion: candidate.manifest.version,
        probeId: probe.probeId,
        response: "correct",
      },
      { outcome: "correct", requirementKey: probe.requirementKey },
    )).toMatchObject({ qualified: true, reasonCodes: ["cartridge_evidence_qualified"] });
  });

  it.each([
    ["undefined field removal", (probe: RuntimeProbe) => {
      Reflect.deleteProperty((probe.input as Record<string, unknown>), "undefinedValue");
    }],
    ["negative zero change", (probe: RuntimeProbe) => {
      (probe.input as Record<string, unknown>).negativeZero = 0;
    }],
    ["NaN change", (probe: RuntimeProbe) => {
      (probe.input as Record<string, unknown>).nan = Number.POSITIVE_INFINITY;
    }],
  ] as const)("rejects a listed probe whose cloned data has %s", (_name, mutate) => {
    const probe = createProbe(undefined, true);
    let runtime = false;
    let mutated = false;
    const candidate = createCandidate(probe, () => {
      if (runtime && !mutated) {
        mutated = true;
        mutate(probe);
      }
      return probe;
    });
    const registry = createCartridgeRegistry([candidate]);
    const registered = registry.getCartridge(candidate.manifest.id)!;
    runtime = true;

    expect(() => registered.getProbe(probe.probeId)).toThrow(
      `Cartridge getProbe(${probe.probeId}) disagrees with listProbes()`,
    );
  });

  it.each([
    ["a distinct lookup object", (probe: RuntimeProbe) => ({ ...probe, parseResponse: () => "divergent" })],
    ["parseResponse", (probe: RuntimeProbe) => { probe.parseResponse = () => "divergent"; return probe; }],
    ["observableKey", (probe: RuntimeProbe) => { probe.observableKey = () => "divergent"; return probe; }],
    ["correctModel.predict", (probe: RuntimeProbe) => {
      (probe.correctModel as { predict: (input: unknown) => unknown }).predict = () => "correct";
      return probe;
    }],
    ["hypotheses[0].predict", (probe: RuntimeProbe) => {
      (probe.hypotheses[0] as { predict: (input: unknown) => unknown }).predict = () => "wrong";
      return probe;
    }],
  ] as const)("rejects runtime agreement drift in %s", (_name, mutate) => {
    const probe = createProbe();
    let runtime = false;
    let mutated = false;
    const candidate = createCandidate(probe, () => {
      if (runtime && !mutated) {
        mutated = true;
        return mutate(probe) as RuntimeProbe;
      }
      return probe;
    });
    const registry = createCartridgeRegistry([candidate]);
    const registered = registry.getCartridge(candidate.manifest.id)!;
    runtime = true;

    expect(() => registered.getProbe(probe.probeId)).toThrow(TypeError);
  });

  it("returns null for a non-string probe id without formatting it", () => {
    const probe = createProbe();
    const candidate = createCandidate(probe, () => probe);
    const registry = createCartridgeRegistry([candidate]);
    const registered = registry.getCartridge(candidate.manifest.id)!;

    expect(registered.getProbe(Object.create(null) as never)).toBeNull();
  });
});
