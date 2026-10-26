import { describe, expect, it } from "vitest";
import type { Diagnostics } from "@aistudy/contracts";
import { diagnosticsVersionEntries, recentDiagnosticsEvents } from "./diagnostics-model";

const diagnostics: Diagnostics = {
  versions: { planner: "plan-1", provider: "mock-1" },
  recentAttemptEvents: [
    { id: "1", ownerUserId: "11111111-1111-4111-8111-111111111111", practiceItemId: "11111111-1111-4111-8111-111111111112", syllabusPointId: "11111111-1111-4111-8111-111111111113", idempotencyKey: "attempt-1", answer: "A", correct: true, assisted: false, durationMs: 1000, hintCount: 0, confidence: 4, errorCause: null, abilitySlice: "recall", contentVersion: 1, schemaVersion: 1, createdAt: "2026-08-03T08:00:00.000Z" },
  ],
  statuses: [],
  planTaskReasons: [],
};

describe("diagnostics model", () => {
  it("orders version entries for a stable read-only panel", () => {
    expect(diagnosticsVersionEntries(diagnostics)).toEqual([
      ["planner", "plan-1"],
      ["provider", "mock-1"],
    ]);
  });

  it("keeps the newest ten attempt events", () => {
    expect(recentDiagnosticsEvents(diagnostics)).toHaveLength(1);
    expect(recentDiagnosticsEvents(diagnostics)[0]?.id).toBe("1");
  });
});
