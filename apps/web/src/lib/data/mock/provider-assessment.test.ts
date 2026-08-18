import { describe, expect, it } from "vitest";
import type { StorageLike } from "./storage";
import { createMockProvider } from "./provider";

const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOW = new Date("2026-08-02T08:00:00.000Z");
const POINT = "99999999-9999-4999-8999-999999999901";

function createMemoryStorage(): StorageLike {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

describe("mock assessment wiring", () => {
  it("disables transfer evidence when the course or goal turns that slice off", async () => {
    const provider = createMockProvider({
      userId: USER_ID,
      now: NOW,
      delayMs: 0,
      storage: createMemoryStorage(),
      disabledSlices: ["transfer"],
    });
    const statuses = await provider.listStatuses();
    expect(statuses.some((item) => item.status === "stable")).toBe(false);
  });

  it("feeds time-pressure error causes into timed-unstable status", async () => {
    const provider = createMockProvider({
      userId: USER_ID,
      now: NOW,
      delayMs: 0,
      storage: createMemoryStorage(),
      syllabus: [{ id: POINT, title: "限时稳定" }],
    });
    const item = await provider.createPracticeItem({
      stem: "限时题",
      answer: "A",
      syllabusPointId: POINT,
    });
    await provider.submitAttempt({
      practiceItemId: item.id,
      answer: "B",
      durationMs: 8000,
      hintCount: 0,
      confidence: 2,
      errorCause: "time",
      assisted: false,
      idempotencyKey: "timed-attempt-01",
    });
    const result = await provider.submitAttempt({
      practiceItemId: item.id,
      answer: "B",
      durationMs: 9000,
      hintCount: 0,
      confidence: 2,
      errorCause: "time",
      assisted: false,
      idempotencyKey: "timed-attempt-02",
    });
    expect(result.status.status).toBe("weak");
    expect(result.status.reasonCodes).toContain("timed-unstable");
  });
});
