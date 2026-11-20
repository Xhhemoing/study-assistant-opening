import { describe, expect, it, vi } from "vitest";
import { cloneCartridgeData } from "./clone-cartridge-data";

describe("cloneCartridgeData", () => {
  it("preserves cycles, shared references, and independently copies supported containers", () => {
    const date = new Date("2026-11-20T00:00:00Z");
    const buffer = new ArrayBuffer(8);
    const bytes = new Uint8Array(buffer, 1, 2);
    const view = new DataView(buffer, 1, 2);
    bytes.set([1, 2]);
    const values = Object.freeze([null, undefined, "stack", 42, true, 1n]);
    const map = new Map<unknown, unknown>([[date, bytes]]);
    const set = new Set([date, view]);
    const payload = Object.assign(Object.create(null), { date, buffer, bytes, view, values, map, set }) as {
      date: Date; buffer: ArrayBuffer; bytes: Uint8Array; view: DataView;
      values: unknown[]; map: Map<unknown, unknown>; set: Set<unknown>; self?: unknown;
    };
    payload.self = payload;
    map.set(payload, set);
    Object.defineProperty(payload, "__proto__", { enumerable: true, value: { stack: true } });

    const copy = cloneCartridgeData(payload);
    expect(copy.self).toBe(copy);
    expect(copy.values).toEqual([null, undefined, "stack", 42, true, 1n]);
    expect(copy.date).not.toBe(date);
    expect(copy.map.get(copy.date)).toBe(copy.bytes);
    expect(copy.map.get(copy)).toBe(copy.set);
    expect(copy.set.has(copy.view)).toBe(true);
    expect(copy.buffer).not.toBe(buffer);
    expect(copy.bytes.buffer).toBe(copy.buffer);
    expect(copy.view.buffer).toBe(copy.buffer);
    expect(Object.getOwnPropertyDescriptor(copy, "__proto__")?.value).toEqual({ stack: true });

    date.setUTCFullYear(2030);
    bytes[0] = 9;
    map.clear();
    set.clear();
    expect(copy.date.toISOString()).toBe("2026-11-20T00:00:00.000Z");
    expect(copy.view.getUint8(0)).toBe(1);
    expect(copy.map.size).toBe(2);
    expect(copy.set.size).toBe(2);
  });

  it.each([
    ["host object", new URL("https://example.com")],
    ["custom prototype", Object.create({ custom: true })],
    ["Node Buffer", Buffer.from([1, 2])],
    ["invalid Date", new Date(NaN)],
    ["symbol key", { [Symbol()]: 1 }],
    ["symbol value", Symbol()],
    ["function value", () => 1],
  ])("rejects a nested %s", (_label, value) => {
    expect(() => cloneCartridgeData(new Map([[value, 0]]))).toThrow(TypeError);
  });

  it("rejects accessor properties without reading them", () => {
    const get = vi.fn(() => 1);
    const value = Object.defineProperty({}, "answer", { enumerable: true, get });
    expect(() => cloneCartridgeData(value)).toThrow(TypeError);
    expect(get).not.toHaveBeenCalled();
  });

  it.each([["object", {}], ["array", [1]]] as const)("rejects a Proxy-backed %s before invoking traps", (_kind, target) => {
    const ownKeys = vi.fn(Reflect.ownKeys);
    const proxy = new Proxy(target, { ownKeys });
    expect(() => cloneCartridgeData(proxy)).toThrow(TypeError);
    expect(() => cloneCartridgeData(new Map([["nested", proxy]]))).toThrow(TypeError);
    expect(ownKeys).not.toHaveBeenCalled();
  });

  it("validates the actual buffer even when the view shadows it", () => {
    const view = new Uint8Array(new SharedArrayBuffer(2));
    Object.defineProperty(view, "buffer", { value: new ArrayBuffer(2) });
    expect(() => cloneCartridgeData(view)).toThrow(TypeError);
  });
});
