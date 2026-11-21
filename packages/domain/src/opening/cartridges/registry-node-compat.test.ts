import { expect, it, vi } from "vitest";

it("registers and grades the stack cartridge and rejects Proxies without getBuiltinModule", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "getBuiltinModule");
  Reflect.deleteProperty(process, "getBuiltinModule");
  try {
    vi.resetModules();
    const {
      createCartridgeRegistry, qualifyCartridgeEmission, stack408Cartridge, toStack408Emission,
    } = await import("@aistudy/domain/opening/cartridges");
    const registry = createCartridgeRegistry();
    expect(registry.registerCartridge(stack408Cartridge)).toMatchObject({ ok: true });

    const probeId = "408.stack.trace.interleaved-underflow.v1";
    const qualify = (response: unknown) => qualifyCartridgeEmission(registry, toStack408Emission(probeId, response));
    expect(qualify({ outputs: "2,3,1,UNDERFLOW", finalTop: -1 })).toMatchObject({
      qualified: true, evaluation: { outcome: "correct" },
    });

    const trap = vi.fn((): never => { throw new Error("Unexpected Proxy trap"); });
    const handler = { get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap };
    for (const proxy of [new Proxy({}, handler), new Proxy([], handler)]) {
      expect(qualify(proxy)).toMatchObject({ qualified: false, reasonCodes: ["cartridge_response_invalid"] });
    }
    expect(registry.registerCartridge({
      ...stack408Cartridge,
      listProbes: () => new Proxy(stack408Cartridge.listProbes(), handler),
    })).toMatchObject({ ok: false, issues: [{ code: "evidence_probe_listing_failed" }] });
    expect(trap).not.toHaveBeenCalled();
  } finally {
    if (descriptor) Object.defineProperty(process, "getBuiltinModule", descriptor);
  }
});
