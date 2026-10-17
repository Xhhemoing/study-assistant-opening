import { describe, expect, it } from "vitest";
import { examSprintCommandSchema } from "./exam-sprint";

const clientKey = "valid-client-key";

describe("exam sprint HTTP commands", () => {
  it("accepts supported command shapes and leap dates", () => {
    const commands = [
      { action: "configure", clientKey, examDate: "2028-02-29", dailyMinutes: 90 },
      { action: "configure", clientKey, examDate: null, dailyMinutes: 15 },
      { action: "start", clientKey, mode: "mock-a" },
      { action: "answer", clientKey, attemptId: "attempt-1", answer: "A", confidence: 5 },
      { action: "help", clientKey, attemptId: "attempt-1", kind: "external" },
      { action: "next", clientKey, runId: "run-1" },
      { action: "finish", clientKey, runId: "run-1" },
      { action: "error", clientKey, attemptId: "attempt-1", errorCause: "conditions" },
      { action: "source", clientKey, sourceId: "original-1", phase: "delayed", outcome: "partial", assistance: "none", durationMinutes: 12.5, errorCause: "time", note: "  slow  " },
    ];
    for (const command of commands) expect(examSprintCommandSchema.safeParse(command).success).toBe(true);
    expect(examSprintCommandSchema.parse(commands.at(-1))).toMatchObject({ note: "slow" });
  });

  it.each(["2026-02-29", "2026-02-30", "2026-13-01", "2026-00-01", "26-10-01", "2026-10-1"])("rejects non-calendar date %s", examDate => {
    expect(examSprintCommandSchema.safeParse({ action: "configure", clientKey, examDate, dailyMinutes: 90 }).success).toBe(false);
  });

  it("rejects answer injection, unknown properties, invalid confidence, ids and unbounded inputs", () => {
    const valid = { action: "answer", clientKey, attemptId: "attempt-1", answer: "A", confidence: 3 };
    for (const invalid of [
      { ...valid, correct: true }, { ...valid, confidence: 0 }, { ...valid, confidence: 6 }, { ...valid, confidence: 2.5 },
      { ...valid, clientKey: "short" }, { ...valid, clientKey: "x".repeat(201) }, { ...valid, attemptId: "x".repeat(101) },
      { ...valid, answer: "" }, { ...valid, answer: "x".repeat(21) }, { ...valid, action: "reset" },
      { action: "help", clientKey, attemptId: "a", kind: "magic" },
    ]) expect(examSprintCommandSchema.safeParse(invalid).success).toBe(false);
  });

  it("rejects invalid time budgets and source inputs", () => {
    for (const dailyMinutes of [14, 721, 90.5, Number.POSITIVE_INFINITY]) {
      expect(examSprintCommandSchema.safeParse({ action: "configure", clientKey, examDate: null, dailyMinutes }).success).toBe(false);
    }
    const valid = { action: "source", clientKey, sourceId: "source-1", phase: "first", outcome: "correct", assistance: "none", durationMinutes: 5, errorCause: null, note: "" };
    for (const invalid of [{ ...valid, durationMinutes: -1 }, { ...valid, durationMinutes: 721 }, { ...valid, note: "x".repeat(2001) }, { ...valid, sourceId: "" }, { ...valid, phase: "mastered" }]) {
      expect(examSprintCommandSchema.safeParse(invalid).success).toBe(false);
    }
  });
});
