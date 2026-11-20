import {
  cloneCartridgeData, copyCartridgeArray, isInspectableCartridgeFunction, isInspectableCartridgeObject,
  readCartridgeDataProperty,
} from "./clone-cartridge-data";
import type { DistinguishableProbeSpec } from "./probe-protocol";

function cloneProbeRecord(value: unknown, callbackKeys: readonly string[], nestedKeys: readonly string[] = []) {
  if (!isInspectableCartridgeObject(value)) {
    throw new TypeError("Cartridge probe requires an inspectable non-Proxy object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Cartridge probe requires a plain record");
  }

  const data: Record<string, unknown> = Object.create(null);
  const callbacks: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new TypeError("Cartridge probe requires string keys");
    const member = readCartridgeDataProperty(value, key);
    if (callbackKeys.includes(key)) {
      if (!isInspectableCartridgeFunction(member)) throw new TypeError(`Cartridge probe requires ${key}()`);
      // Forward the receiver without exposing the cartridge's original function object.
      callbacks[key] = {
        invoke(this: unknown, ...args: never[]) {
          return Reflect.apply(member, this, args);
        },
      }.invoke;
    } else if (!nestedKeys.includes(key)) {
      data[key] = member;
    }
  }
  return { ...cloneCartridgeData(data), ...callbacks };
}

/** Copy probe data independently while retaining its descriptor-checked behavior. */
export function cloneProbeDefinition(value: unknown): DistinguishableProbeSpec<unknown, unknown> {
  const record = cloneProbeRecord(value, ["observableKey", "parseResponse"], ["correctModel", "hypotheses"]);
  const correctModel = cloneProbeRecord(readCartridgeDataProperty(value, "correctModel"), ["predict"]);
  const hypotheses = copyCartridgeArray(readCartridgeDataProperty(value, "hypotheses") as readonly unknown[])
    .map(model => cloneProbeRecord(model, ["predict"]));
  return { ...record, correctModel, hypotheses } as unknown as DistinguishableProbeSpec<unknown, unknown>;
}

/** Freeze trusted probe containers. Built-ins with mutable internal slots cannot be published as frozen data. */
export function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value === "function") return Object.freeze(value);
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Array.prototype && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Immutable cartridge probe data requires plain records and arrays");
  }
  seen.add(value);
  for (const member of Object.values(value)) deepFreeze(member, seen);
  return Object.freeze(value);
}
