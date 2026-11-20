const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayPrototypes = new Set<object>([
  Int8Array.prototype, Uint8Array.prototype, Uint8ClampedArray.prototype,
  Int16Array.prototype, Uint16Array.prototype, Int32Array.prototype, Uint32Array.prototype,
  Float32Array.prototype, Float64Array.prototype, BigInt64Array.prototype, BigUint64Array.prototype,
]);
const float16Array = Reflect.get(globalThis, "Float16Array") as { prototype: object } | undefined;
if (float16Array) typedArrayPrototypes.add(float16Array.prototype);

function requirePrivateArrayBuffer(value: object): void {
  if (Object.getPrototypeOf(value) !== ArrayBuffer.prototype) {
    throw new TypeError("Cartridge data requires an ordinary ArrayBuffer");
  }
  // The intrinsic verifies the backing store's brand even if the prototype was reassigned.
  Reflect.get(ArrayBuffer.prototype, "byteLength", value);
}

function projectCartridgeData(value: unknown, seen: WeakMap<object, object>): unknown {
  if (typeof value === "symbol" || typeof value === "function") {
    throw new TypeError("Cartridge data cannot contain symbols or functions");
  }
  if (value === null || typeof value !== "object") return value;
  const existing = seen.get(value);
  if (existing) return existing;

  const prototype = Object.getPrototypeOf(value) as object | null;
  if (ArrayBuffer.isView(value)) {
    if (prototype !== DataView.prototype && (!prototype || !typedArrayPrototypes.has(prototype))) {
      throw new TypeError("Cartridge data requires a standard binary view");
    }
    // Bypass own properties that could shadow the view's actual buffer.
    const viewPrototype = prototype === DataView.prototype ? DataView.prototype : typedArrayPrototype;
    requirePrivateArrayBuffer(Reflect.get(viewPrototype, "buffer", value) as object);
    return value;
  }
  if (prototype === ArrayBuffer.prototype) {
    requirePrivateArrayBuffer(value);
    return value;
  }
  if (prototype === Date.prototype) {
    if (!Number.isFinite(Date.prototype.getTime.call(value))) throw new TypeError("Cartridge data requires a valid Date");
    return value;
  }
  if (prototype === Map.prototype) {
    const copy = new Map<unknown, unknown>();
    seen.set(value, copy);
    Map.prototype.forEach.call(value, (entry: unknown, key: unknown) => {
      copy.set(projectCartridgeData(key, seen), projectCartridgeData(entry, seen));
    });
    return copy;
  }
  if (prototype === Set.prototype) {
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
  const copy: object = isArray ? new Array(value.length) : {};
  seen.set(value, copy);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key === "symbol" || !descriptor || !("value" in descriptor)) {
      throw new TypeError("Cartridge data requires own string data properties");
    }
    const index = Number(key);
    const isArrayElement = Array.isArray(copy) && String(index) === key
      && Number.isInteger(index) && index >= 0 && index < copy.length;
    if (descriptor.enumerable || isArrayElement) {
      Object.defineProperty(copy, key, { enumerable: true, value: projectCartridgeData(descriptor.value, seen) });
    }
  }
  if (Array.isArray(copy)) {
    for (let index = 0; index < copy.length; index += 1) {
      if (!Object.hasOwn(copy, index)) throw new TypeError("Cartridge data requires dense arrays");
    }
  }
  return copy;
}

/** Capture pure values with independently copied mutable state. */
export function cloneCartridgeData<T>(value: T): T {
  // Only fresh containers and verified built-in leaves reach the native clone.
  // Cloning the binary leaves together preserves relationships between buffers and views.
  return structuredClone(projectCartridgeData(value, new WeakMap())) as T;
}
