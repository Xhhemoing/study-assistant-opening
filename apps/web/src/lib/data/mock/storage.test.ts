import { describe, expect, it } from "vitest";
import {
  loadDomain,
  mockKey,
  resetDomains,
  saveDomain,
  type StorageLike,
} from "./storage";

export function createMemoryStorage(): StorageLike & { dump(): Map<string, string> } {
  const map = new Map<string, string>();
  return {
    getItem: (key) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
    dump: () => map,
  };
}

describe("mock storage", () => {
  it("formats keys per user and domain", () => {
    expect(mockKey("u1", "goals")).toBe("aistudy:mock:v1:u1:goals");
  });

  it("round-trips JSON values", () => {
    const storage = createMemoryStorage();
    saveDomain(storage, "u1", "goals", [{ id: "g1" }]);
    expect(loadDomain(storage, "u1", "goals", [])).toEqual([{ id: "g1" }]);
  });

  it("returns the fallback for missing or corrupted data", () => {
    const storage = createMemoryStorage();
    expect(loadDomain(storage, "u1", "missing", "fb")).toBe("fb");
    storage.setItem(mockKey("u1", "broken"), "{not-json");
    expect(loadDomain(storage, "u1", "broken", "fb")).toBe("fb");
  });

  it("namespaces per user", () => {
    const storage = createMemoryStorage();
    saveDomain(storage, "u1", "goals", [1]);
    expect(loadDomain(storage, "u2", "goals", [])).toEqual([]);
  });

  it("resets only the requested domains", () => {
    const storage = createMemoryStorage();
    saveDomain(storage, "u1", "goals", [1]);
    saveDomain(storage, "u1", "plans", [2]);
    resetDomains(storage, "u1", ["goals"]);
    expect(loadDomain(storage, "u1", "goals", [])).toEqual([]);
    expect(loadDomain(storage, "u1", "plans", [])).toEqual([2]);
  });
});
