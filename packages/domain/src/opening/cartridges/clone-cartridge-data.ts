// Domain also has browser consumers. Resolve the Node detector without a static runtime import.
const isProxy = (globalThis.process?.getBuiltinModule?.("node:util") as typeof import("node:util") | undefined)
  ?.types.isProxy;

export function isInspectableCartridgeObject(value: unknown): value is object {
  // A runtime without the detector cannot safely trust a descriptor snapshot.
  return value !== null && typeof value === "object" && isProxy?.(value) === false;
}

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayPrototypes = new Set<object>([
  Int8Array.prototype, Uint8Array.prototype, Uint8ClampedArray.prototype,
  Int16Array.prototype, Uint16Array.prototype, Int32Array.prototype, Uint32Array.prototype,
  Float32Array.prototype, Float64Array.prototype, BigInt64Array.prototype, BigUint64Array.prototype,
]);
const float16Array = Reflect.get(globalThis, "Float16Array") as { prototype: object } | undefined;
if (float16Array) typedArrayPrototypes.add(float16Array.prototype);

function requireNoOwnProperties(value: object): void {
  if (Reflect.ownKeys(value).length !== 0) {
    throw new TypeError("Cartridge data contains an unexpected own property");
  }
}

function readEnumerableDataProperty(value: object, key: string | symbol): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (typeof key !== "string" || !descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
    throw new TypeError("Cartridge data requires enumerable own string data properties");
  }
  return descriptor.value;
}

function isElementIndex(key: string | symbol, length: number): boolean {
  if (typeof key !== "string") return false;
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < length && String(index) === key;
}

/** Snapshot a dense list of cartridge definitions while preserving element identity. */
export function copyCartridgeArray<T>(value: readonly T[]): T[] {
  if (!isInspectableCartridgeObject(value) || !Array.isArray(value)) {
    throw new TypeError("Cartridge list requires an inspectable non-Proxy array");
  }
  const length: unknown = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (typeof length !== "number" || !Number.isInteger(length) || length < 0 || length > 0xffff_ffff) {
    throw new TypeError("Cartridge list has an invalid array length");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1) throw new TypeError("Cartridge list requires only dense array elements");

  const copy = new Array<T>(length);
  for (const key of keys) {
    if (key === "length") continue;
    if (!isElementIndex(key, length)) throw new TypeError("Cartridge list requires canonical array indices");
    copy[Number(key)] = readEnumerableDataProperty(value, key) as T;
  }
  return copy;
}

function requirePrivateArrayBuffer(value: object): void {
  if (Object.getPrototypeOf(value) !== ArrayBuffer.prototype) {
    throw new TypeError("Cartridge data requires an ordinary ArrayBuffer");
  }
  // The intrinsic verifies the backing store's brand even if the prototype was reassigned.
  Reflect.get(ArrayBuffer.prototype, "byteLength", value);
  requireNoOwnProperties(value);
}

function projectCartridgeData(value: unknown, seen: WeakMap<object, object>): unknown {
  if (typeof value === "symbol" || typeof value === "function") {
    throw new TypeError("Cartridge data cannot contain symbols or functions");
  }
  if (value === null || typeof value !== "object") return value;
  if (!isInspectableCartridgeObject(value)) {
    throw new TypeError("Cartridge data requires inspectable non-Proxy objects");
  }
  const existing = seen.get(value);
  if (existing) return existing;

  const prototype = Object.getPrototypeOf(value) as object | null;
  if (ArrayBuffer.isView(value)) {
    if (prototype !== DataView.prototype && (!prototype || !typedArrayPrototypes.has(prototype))) {
      throw new TypeError("Cartridge data requires a standard binary view");
    }
    const isDataView = prototype === DataView.prototype;
    if (isDataView) {
      requireNoOwnProperties(value);
    } else {
      const length = Reflect.get(typedArrayPrototype, "length", value) as number;
      const keys = Reflect.ownKeys(value);
      if (keys.length !== length) throw new TypeError("Cartridge data requires only typed array elements");
      for (const key of keys) {
        if (!isElementIndex(key, length)) throw new TypeError("Cartridge data requires canonical typed array indices");
        readEnumerableDataProperty(value, key);
      }
    }
    // The backing buffer is part of the clone even when reached only through a view.
    const viewPrototype = isDataView ? DataView.prototype : typedArrayPrototype;
    requirePrivateArrayBuffer(Reflect.get(viewPrototype, "buffer", value) as object);
    return value;
  }
  if (prototype === ArrayBuffer.prototype) {
    requirePrivateArrayBuffer(value);
    return value;
  }
  if (prototype === Date.prototype) {
    requireNoOwnProperties(value);
    if (!Number.isFinite(Date.prototype.getTime.call(value))) throw new TypeError("Cartridge data requires a valid Date");
    return value;
  }
  if (prototype === Map.prototype) {
    requireNoOwnProperties(value);
    const copy = new Map<unknown, unknown>();
    seen.set(value, copy);
    Map.prototype.forEach.call(value, (entry: unknown, key: unknown) => {
      copy.set(projectCartridgeData(key, seen), projectCartridgeData(entry, seen));
    });
    return copy;
  }
  if (prototype === Set.prototype) {
    requireNoOwnProperties(value);
    const copy = new Set<unknown>();
    seen.set(value, copy);
    Set.prototype.forEach.call(value, (entry: unknown) => {
      copy.add(projectCartridgeData(entry, seen));
    });
    return copy;
  }

  const isArray = Array.isArray(value);
  if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Cartridge data contains an unsupported object");
  }
  const keys = Reflect.ownKeys(value);
  const length: unknown = isArray ? Object.getOwnPropertyDescriptor(value, "length")?.value : 0;
  // Own keys are unique. Requiring all indices plus length rules out holes.
  if (typeof length !== "number" || (isArray && keys.length !== length + 1)) {
    throw new TypeError("Cartridge data requires dense arrays");
  }
  const copy: object = isArray ? new Array<unknown>(length) : {};
  seen.set(value, copy);
  for (const key of keys) {
    if (isArray && key === "length") continue;
    if (isArray && !isElementIndex(key, length)) throw new TypeError("Cartridge data requires canonical array indices");
    const entry = readEnumerableDataProperty(value, key);
    Object.defineProperty(copy, key, { enumerable: true, value: projectCartridgeData(entry, seen) });
  }
  return copy;
}

/** Capture pure values with independently copied mutable state. */
export function cloneCartridgeData<T>(value: T): T {
  // Only fresh containers and verified built-in leaves reach the native clone.
  // Cloning the binary leaves together preserves relationships between buffers and views.
  return structuredClone(projectCartridgeData(value, new WeakMap())) as T;
}
