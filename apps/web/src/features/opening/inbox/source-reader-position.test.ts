import { describe, expect, it } from "vitest";
import { rememberSourceReaderPage, sourceReaderInitialPage } from "./source-reader-position";

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

describe("source reader's tab-local confirmed text page", () => {
  it("restores the last confirmed page for the same source and version", () => {
    const preferences = storage();
    rememberSourceReaderPage("source-a", 0, 12, preferences);
    expect(sourceReaderInitialPage("source-a", 0, undefined, preferences)).toBe(12);
    expect(sourceReaderInitialPage("source-a", 1, undefined, preferences)).toBeUndefined();
    expect(sourceReaderInitialPage("source-b", 0, undefined, preferences)).toBeUndefined();
  });
  it("lets an explicit citation page override the reader's own last position", () => {
    const preferences = storage();
    rememberSourceReaderPage("source-a", 0, 12, preferences);
    expect(sourceReaderInitialPage("source-a", 0, 3, preferences)).toBe(3);
  });
  it.each(["invalid", "-3", "0", "2.5", "Infinity", "9007199254740992"])("ignores invalid saved positions: %s", value => {
    expect(sourceReaderInitialPage("source-a", 0, undefined, { getItem: () => value, setItem: () => {} })).toBeUndefined();
  });
  it("keeps reading available when preference storage is denied and skips unnumbered pages", () => {
    const denied = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    expect(sourceReaderInitialPage("source-a", 0, undefined, denied)).toBeUndefined();
    expect(sourceReaderInitialPage("source-a", 0, 2, denied)).toBe(2);
    expect(() => rememberSourceReaderPage("source-a", 0, 2, denied)).not.toThrow();
    const preferences = storage();
    rememberSourceReaderPage("source-a", 0, null, preferences);
    expect(sourceReaderInitialPage("source-a", 0, undefined, preferences)).toBeUndefined();
  });
});
