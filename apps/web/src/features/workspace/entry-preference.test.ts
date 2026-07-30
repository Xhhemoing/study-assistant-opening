import { describe, expect, it } from "vitest";
import { readDefaultEntry, writeDefaultEntry, type PreferenceStorage } from "./entry-preference";

function memoryStorage(): PreferenceStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  };
}

describe("default workspace entry preference", () => {
  it("returns no choice until the user selects an entry", () => {
    expect(readDefaultEntry(memoryStorage(), "user-a")).toBeNull();
  });

  it("stores valid choices per account and ignores corrupted values", () => {
    const storage = memoryStorage();
    writeDefaultEntry(storage, "user-a", "explore");
    writeDefaultEntry(storage, "user-b", "library");

    expect(readDefaultEntry(storage, "user-a")).toBe("explore");
    expect(readDefaultEntry(storage, "user-b")).toBe("library");

    storage.values.set("aistudy.default-entry.user-a", "unknown");
    expect(readDefaultEntry(storage, "user-a")).toBeNull();
  });
});
