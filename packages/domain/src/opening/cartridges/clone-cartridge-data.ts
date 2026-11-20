/** Capture structured-cloneable data without retaining any shared backing memory. */
export function cloneCartridgeData<T>(value: T): T {
  const clone = structuredClone(value);
  const pending: unknown[] = [clone];
  const seen = new WeakSet<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);

    if (Object.prototype.toString.call(current) === "[object SharedArrayBuffer]"
      || (typeof WebAssembly !== "undefined" && current instanceof WebAssembly.Memory)) {
      throw new TypeError("Cartridge data cannot contain shared memory");
    }
    if (ArrayBuffer.isView(current)) {
      pending.push(current.buffer);
      continue;
    }
    if (current instanceof Map) {
      for (const [key, entry] of current) pending.push(key, entry);
    } else if (current instanceof Set) {
      for (const entry of current) pending.push(entry);
    }
    // Error causes and other structured-cloned properties can be non-enumerable.
    for (const key of Reflect.ownKeys(current)) {
      pending.push(Object.getOwnPropertyDescriptor(current, key)?.value);
    }
  }
  return clone;
}
