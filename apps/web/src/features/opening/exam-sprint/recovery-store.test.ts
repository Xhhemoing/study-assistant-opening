import { afterEach, describe, expect, it, vi } from "vitest";
import { sprintRecoveryStore } from "./recovery-store";

const fingerprint = (value: number) => value.toString(16).padStart(64, "0");

afterEach(() => vi.unstubAllGlobals());

describe("sprint recovery storage", () => {
  it("keeps an unresolved review key when later resolved entries fill the LRU", () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("window", { sessionStorage: {
      getItem: (name: string) => storage.get(name) ?? null,
      setItem: (name: string, value: string) => { storage.set(name, value); },
      removeItem: (name: string) => { storage.delete(name); },
    } });
    const store = sprintRecoveryStore("workspace", "course");
    const reviewFingerprint = fingerprint(0);
    store.remember(reviewFingerprint, "review-key", { protected: true });
    for (let index = 1; index <= 32; index += 1) store.remember(fingerprint(index), `key-${index}`);
    expect(store.get(reviewFingerprint)).toBe("review-key");
    expect(store.get(fingerprint(1))).toBeUndefined();
  });

  it("keeps working when sessionStorage is unavailable", () => {
    vi.stubGlobal("window", {});
    const store = sprintRecoveryStore("workspace", "course");
    store.remember(fingerprint(1), "memory-key");
    expect(store.get(fingerprint(1))).toBe("memory-key");
  });
});
