import { describe, expect, it, vi } from "vitest";
import { verifyProbeDistinguishability, type DistinguishableProbeSpec } from "./probe-protocol";
import { createCartridgeRegistry } from "./registry";
import { stack408Cartridge } from "./stack-408-v1";
import { hasEvidenceCapability } from "./types";

function fixture() {
  return {
    probeId: "double-3",
    requirementKey: "arithmetic.double",
    prompt: "What is twice the input?",
    input: { n: 3 },
    correctModel: {
      id: "double", label: "Double", role: "correct" as const,
      predict: ({ n }: { n: number }) => 2 * n,
    },
    hypotheses: [{
      id: "square", label: "Square", role: "misconception" as const,
      description: "Squares the input.",
      predict: ({ n }: { n: number }) => n ** 2,
    }],
    observableKey: (value: number) => String(value),
    parseResponse: (value: unknown) => typeof value === "number" ? value : null,
  } satisfies DistinguishableProbeSpec<{ n: number }, number>;
}

type Probe = ReturnType<typeof fixture>;

function cartridgeFor(getProbe: () => Probe) {
  return { ...stack408Cartridge, listProbes: () => [getProbe()], getProbe };
}

function registerValid(getProbe: () => Probe) {
  const candidate = cartridgeFor(getProbe);
  const registry = createCartridgeRegistry([candidate]);
  const registered = registry.getCartridge(candidate.manifest.id)!;
  if (!hasEvidenceCapability(registered)) throw new Error("Expected an evidence cartridge");
  return registered;
}

function expectSchemaRejection(invalidate: (probe: Probe) => Probe | void) {
  let probe = fixture();
  const candidate = cartridgeFor(() => probe);
  const registered = registerValid(() => probe);
  probe = invalidate(probe) ?? probe;
  const registry = createCartridgeRegistry();

  expect(registry.registerCartridge(candidate)).toMatchObject({
    ok: false, issues: [{ code: "evidence_probe_not_distinguishable" }],
  });
  expect(registry.getCartridge(candidate.manifest.id)).toBeNull();
  expect(verifyProbeDistinguishability(probe).distinguishable).toBe(false);
  expect(() => registered.getProbe("double-3")).toThrow(TypeError);
  expect(() => registered.listProbes()).toThrow(TypeError);
}

const fields = <T extends object>(
  path: string,
  select: (probe: Probe) => T,
  invalid: { [K in keyof T]-?: readonly unknown[] },
) => (Object.keys(invalid) as (keyof T & string)[]).map(key => ({
  path: path + key, select, key, malformed: invalid[key],
}));

const nonBlank = [0, "", " \t\n "];
const requiredFields = [
  ...fields("", probe => probe, {
    probeId: nonBlank,
    requirementKey: nonBlank,
    prompt: nonBlank,
    input: [Symbol("input"), new Date(0)],
    correctModel: [null, [], 1],
    hypotheses: [null, {}, [], Array(1)],
    observableKey: [undefined, "observable"],
    parseResponse: [undefined, "parser"],
  }),
  ...fields("correctModel.", probe => probe.correctModel, {
    id: nonBlank,
    label: nonBlank,
    role: [null, "misconception", " correct "],
    predict: [undefined, {}],
  }),
  ...fields("hypotheses[0].", probe => probe.hypotheses[0]!, {
    id: nonBlank,
    label: nonBlank,
    role: [null, "correct", "MISCONCEPTION"],
    description: nonBlank,
    predict: [undefined, {}],
  }),
];

describe("probe definition validation", () => {
  it.each(requiredFields)("requires $path as an own property", ({ select, key }) => {
    expectSchemaRejection(probe => { Reflect.deleteProperty(select(probe), key); });
  });

  it.each(requiredFields)("rejects malformed $path", ({ select, key, malformed }) => {
    for (const value of malformed) {
      expectSchemaRejection(probe => { Reflect.set(select(probe), key, value); });
    }
  });

  it.each(requiredFields)("does not invoke a getter for $path", ({ select, key }) => {
    const get = vi.fn(() => { throw new Error("Getter invoked"); });
    expectSchemaRejection(probe => {
      Object.defineProperty(select(probe), key, { get, enumerable: true });
    });
    expect(get).not.toHaveBeenCalled();
  });

  it.each(requiredFields)("rejects non-enumerable $path", ({ select, key }) => {
    expectSchemaRejection(probe => {
      Object.defineProperty(select(probe), key, { enumerable: false });
    });
  });

  it.each([
    ["probe object", (probe: Probe) => probe],
    ["correct model", (probe: Probe) => probe.correctModel],
    ["hypothesis", (probe: Probe) => probe.hypotheses[0]!],
    ["hypothesis array", (probe: Probe) => probe.hypotheses],
  ] as const)("rejects a custom prototype on the %s", (_kind, select) => {
    expectSchemaRejection(probe => {
      Object.setPrototypeOf(select(probe), Object.create(Object.getPrototypeOf(select(probe))));
    });
  });

  it.each([
    "probe", "correctModel", "hypothesis", "hypotheses",
    "input", "observableKey", "parseResponse", "correct predict", "hypothesis predict",
  ] as const)("rejects a Proxy for %s without invoking traps", field => {
    const trap = vi.fn((): never => { throw new Error("Proxy trap invoked"); });
    const wrap = <T extends object>(value: T) => new Proxy(value, {
      get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap, apply: trap,
    });
    expectSchemaRejection(probe => {
      switch (field) {
        case "probe": return wrap(probe);
        case "hypothesis": probe.hypotheses[0] = wrap(probe.hypotheses[0]!); break;
        case "correct predict": probe.correctModel.predict = wrap(probe.correctModel.predict); break;
        case "hypothesis predict": probe.hypotheses[0]!.predict = wrap(probe.hypotheses[0]!.predict); break;
        default: Reflect.set(probe, field, wrap(probe[field]));
      }
    });
    expect(trap).not.toHaveBeenCalled();
  });

  it("validates null-prototype definitions and publishes independent frozen copies", () => {
    const probe = fixture();
    Object.setPrototypeOf(probe, null);
    Object.setPrototypeOf(probe.correctModel, null);
    Object.setPrototypeOf(probe.hypotheses[0]!, null);
    const registered = registerValid(() => probe);
    const listed = registered.listProbes();
    const lookup = registered.getProbe(probe.probeId)!;
    expect(listed.map(item => item.probeId)).toEqual([lookup.probeId]);
    expect(listed[0]).not.toBe(lookup);
    expect(lookup.correctModel).not.toBe(probe.correctModel);
    expect(lookup.hypotheses[0]).not.toBe(probe.hypotheses[0]);
    expect(lookup.input).not.toBe(probe.input);
    for (const value of [
      listed, lookup, lookup.input, lookup.parseResponse, lookup.observableKey,
      lookup.correctModel, lookup.correctModel.predict, lookup.hypotheses,
      lookup.hypotheses[0], lookup.hypotheses[0]!.predict,
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(Object.isFrozen(probe.parseResponse)).toBe(false);
    expect(lookup.parseResponse(6)).toBe(6);
    expect(lookup.observableKey(6)).toBe("6");
  });
});

describe("runtime probe verification", () => {
  it.each([
    ["blank observable key", (probe: Probe) => { probe.observableKey = () => " "; }, "invalid_observable_key"],
    ["duplicate model id", (probe: Probe) => { probe.hypotheses[0]!.id = probe.correctModel.id; }, "duplicate_model_id"],
    ["degenerate prediction", (probe: Probe) => { probe.hypotheses[0]!.predict = probe.correctModel.predict; }, "degenerate_against_correct_model"],
    ["nondeterministic prediction", (probe: Probe) => {
      let calls = 0;
      probe.hypotheses[0]!.predict = () => 9 + calls++ % 2;
    }, "nondeterministic_prediction"],
  ] as const)("rejects a %s from a dynamic runtime hook", (_kind, invalidate, issue) => {
    const original = fixture();
    const invalid = fixture();
    invalidate(invalid);
    let served = original;
    const registered = registerValid(() => served);
    served = invalid;

    expect(verifyProbeDistinguishability(invalid).issues).toContain(issue);
    expect(() => registered.getProbe(original.probeId)).toThrow(issue);
    expect(() => registered.listProbes()).toThrow(issue);
    served = original;
    expect(registered.getProbe(original.probeId)?.prompt).toBe(original.prompt);
    expect(registered.listProbes().map(probe => probe.probeId)).toEqual([original.probeId]);
  });

  it("verifies callbacks with the same immutable receiver returned by getProbe", () => {
    const probe = fixture();
    const verifiedReceivers = new Set<unknown>();
    probe.observableKey = function (this: Probe, value: number) {
      verifiedReceivers.add(this);
      return String(value);
    };
    const registered = registerValid(() => probe);
    const lookup = registered.getProbe(probe.probeId);
    expect(lookup).not.toBeNull();
    expect(verifiedReceivers.has(lookup)).toBe(true);
  });

  it("rejects a previously validated probe when its encoder starts returning invalid keys", () => {
    const probe = fixture();
    const registered = registerValid(() => probe);
    const previous = registered.getProbe(probe.probeId)!;
    probe.observableKey = () => " ";

    expect(() => registered.getProbe(probe.probeId)).toThrow("invalid_observable_key");
    expect(() => registered.listProbes()).toThrow("invalid_observable_key");
    expect(previous.observableKey(6)).toBe("6");
  });
});
