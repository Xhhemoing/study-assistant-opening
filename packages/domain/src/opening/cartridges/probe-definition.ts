import {
  clonePlainCartridgeData, copyCartridgeArray, isInspectableCartridgeFunction, isInspectableCartridgeObject,
  isPlainCartridgeRecord,
  readCartridgeDataProperty,
} from "./clone-cartridge-data";
import { isValidObservableKey, type DistinguishableProbeSpec } from "./probe-protocol";

function cloneProbeRecord(value: unknown, callbackKeys: readonly string[], nestedKeys: readonly string[] = []) {
  if (!isPlainCartridgeRecord(value)) {
    throw new TypeError("Cartridge probe requires a plain record");
  }

  const data: Record<string, unknown> = Object.create(null);
  const callbacks: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new TypeError("Cartridge probe requires string keys");
    const member = readCartridgeDataProperty(value, key);
    if (callbackKeys.includes(key)) {
      if (key === "parseResponse" && member === undefined) continue;
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
  return { ...clonePlainCartridgeData(data), ...callbacks };
}

function cloneProbeModel(value: unknown) {
  const model = cloneProbeRecord(value, ["predict"]);
  if (!Object.hasOwn(model, "id") || !isValidObservableKey(model.id)
    || !Object.hasOwn(model, "predict")) {
    throw new TypeError("Cartridge probe model requires an id and predict()");
  }
  return model;
}

/** Copy probe data independently while retaining its descriptor-checked behavior. */
export function cloneProbeDefinition(value: unknown): DistinguishableProbeSpec<unknown, unknown> {
  const record = cloneProbeRecord(value, ["observableKey", "parseResponse"], ["correctModel", "hypotheses"]);
  if (!Object.hasOwn(record, "probeId") || !isValidObservableKey(record.probeId)
    || !Object.hasOwn(record, "requirementKey") || !isValidObservableKey(record.requirementKey)
    || !Object.hasOwn(record, "observableKey") || !Object.hasOwn(record, "input")) {
    throw new TypeError("Cartridge probe requires a probeId, requirementKey, observableKey(), and input");
  }
  const correctModel = cloneProbeModel(readCartridgeDataProperty(value, "correctModel"));
  const rawHypotheses = readCartridgeDataProperty(value, "hypotheses");
  if (!isInspectableCartridgeObject(rawHypotheses) || Object.getPrototypeOf(rawHypotheses) !== Array.prototype) {
    throw new TypeError("Cartridge probe requires a plain hypotheses array");
  }
  const hypotheses = copyCartridgeArray(rawHypotheses as readonly unknown[]).map(cloneProbeModel);
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
