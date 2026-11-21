import {
  clonePlainCartridgeData, copyCartridgeArray, isInspectableCartridgeFunction, isInspectableCartridgeObject,
  isPlainCartridgeRecord, readCartridgeDataProperty,
} from "./clone-cartridge-data";
import type { DistinguishableProbeSpec } from "./probe-protocol";

const clonedDefinitions = new WeakSet<object>();

export function isClonedProbeDefinition(value: object): boolean {
  return clonedDefinitions.has(value);
}

export function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export class ProbeDefinitionError extends TypeError {
  constructor(
    readonly issue: "probe_identity_incomplete" | "no_competing_hypotheses",
    message: string,
  ) {
    super(message);
  }
}

function cloneProbeRecord(value: unknown, callbackKeys: readonly string[], nestedKeys: readonly string[] = []) {
  if (!isPlainCartridgeRecord(value)) {
    throw new TypeError("Cartridge probe requires a plain record");
  }

  const callbacks: Record<string, unknown> = Object.create(null);
  for (const key of callbackKeys) {
    const member = readCartridgeDataProperty(value, key);
    if (!isInspectableCartridgeFunction(member)) throw new TypeError(`Cartridge probe requires ${key}()`);
    // Forward the receiver without exposing the cartridge's original function object.
    callbacks[key] = {
      invoke(this: unknown, ...args: never[]) {
        return Reflect.apply(member, this, args);
      },
    }.invoke;
  }

  const data: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new TypeError("Cartridge probe requires string keys");
    if (!Object.hasOwn(callbacks, key) && !nestedKeys.includes(key)) {
      data[key] = readCartridgeDataProperty(value, key);
    }
  }
  return { ...clonePlainCartridgeData(data), ...callbacks };
}

function hasProbeText(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key) && isNonBlankString(record[key]);
}

function cloneProbeModel(value: unknown, role: "correct" | "misconception") {
  const model = cloneProbeRecord(value, ["predict"]);
  if (!hasProbeText(model, "id") || !hasProbeText(model, "label")
    || !Object.hasOwn(model, "role") || model.role !== role) {
    throw new TypeError(`Cartridge probe model requires an id, label, and role "${role}"`);
  }
  if (role === "misconception" && !hasProbeText(model, "description")) {
    throw new TypeError("Cartridge probe hypothesis requires a description");
  }
  return model;
}

/** Copy the complete probe definition before running any of its callbacks. */
export function cloneProbeDefinition<TInput, TObservable>(
  value: DistinguishableProbeSpec<TInput, TObservable>,
): DistinguishableProbeSpec<TInput, TObservable>;
export function cloneProbeDefinition(value: unknown): DistinguishableProbeSpec<unknown, unknown>;
export function cloneProbeDefinition(value: unknown): DistinguishableProbeSpec<unknown, unknown> {
  const record = cloneProbeRecord(value, ["observableKey", "parseResponse"], ["correctModel", "hypotheses"]);
  if (!hasProbeText(record, "probeId") || !hasProbeText(record, "requirementKey") || !hasProbeText(record, "prompt")) {
    throw new ProbeDefinitionError("probe_identity_incomplete", "Cartridge probe requires a probeId, requirementKey, and prompt");
  }
  if (!Object.hasOwn(record, "input")) throw new TypeError("Cartridge probe requires an input");

  const correctModel = cloneProbeModel(readCartridgeDataProperty(value, "correctModel"), "correct");
  const rawHypotheses = readCartridgeDataProperty(value, "hypotheses");
  if (!isInspectableCartridgeObject(rawHypotheses) || Object.getPrototypeOf(rawHypotheses) !== Array.prototype) {
    throw new TypeError("Cartridge probe requires a plain hypotheses array");
  }
  const hypotheses = copyCartridgeArray(rawHypotheses as readonly unknown[])
    .map(model => cloneProbeModel(model, "misconception"));
  if (hypotheses.length === 0) {
    throw new ProbeDefinitionError("no_competing_hypotheses", "Cartridge probe requires at least one misconception hypothesis");
  }
  const clone = deepFreeze({ ...record, correctModel, hypotheses });
  clonedDefinitions.add(clone);
  return clone as unknown as DistinguishableProbeSpec<unknown, unknown>;
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
