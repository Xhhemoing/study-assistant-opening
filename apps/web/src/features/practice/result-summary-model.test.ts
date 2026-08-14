import { describe, expect, it } from "vitest";
import type { AttemptEvent, Diagnostics, StatusResult } from "@aistudy/contracts";
import {
  buildInterventionSummary,
  findPracticeResult,
  getAttemptEvidenceLabel,
  reasonCodeLabel,
  statusWordLabel,
} from "./result-summary-model";

const event: AttemptEvent = {
  id: "77777777-7777-4777-8777-777777777701",
  ownerUserId: "11111111-1111-4111-8111-111111111111",
  practiceItemId: "22222222-2222-4222-8222-222222222201",
  syllabusPointId: "11111111-1111-4111-8111-111111111101",
  idempotencyKey: "result-event-001",
  answer: "A",
  correct: true,
  assisted: false,
  durationMs: 12000,
  hintCount: 0,
  confidence: 4,
  errorCause: null,
  abilitySlice: "recall",
  contentVersion: 1,
  schemaVersion: 1,
  createdAt: "2026-08-03T08:00:00.000Z",
};

const status: StatusResult = {
  syllabusPointId: event.syllabusPointId,
  status: "usable",
  summaryMetrics: [],
  reasonCodes: ["partial-mastery"],
  recommendedActions: [],
  evidenceSnapshotId: "snap-result",
  strategyVersion: "assess-1",
  modelVersion: "rules-1",
  computedAt: "2026-08-03T08:00:00.000Z",
};

describe("practice result summary model", () => {
  it("finds the submitted event and its matching status", () => {
    const diagnostics: Diagnostics = {
      versions: {},
      recentAttemptEvents: [event],
      statuses: [status],
      planTaskReasons: [],
    };

    expect(findPracticeResult(diagnostics, event.id)).toEqual({ event, status });
    expect(findPracticeResult(diagnostics, "77777777-7777-4777-8777-777777777799")).toBeNull();
  });

  it("maps status and reason codes to user-facing labels", () => {
    expect(statusWordLabel("stable")).toBe("稳固");
    expect(statusWordLabel("untested")).toBe("未测");
    expect(reasonCodeLabel("recent-failure")).toContain("最近一次作答");
    expect(reasonCodeLabel("unknown-reason")).toBe("系统记录的状态原因");
  });

  it("explains whether an attempt is independent evidence", () => {
    expect(getAttemptEvidenceLabel(event)).toContain("有效证据");
    expect(getAttemptEvidenceLabel({ ...event, assisted: true })).toContain("不计入");
  });
});

describe("buildInterventionSummary", () => {
  const wrongEvent: AttemptEvent = {
    ...event,
    correct: false,
    confidence: 2,
    errorCause: "concept",
    createdAt: "2026-08-14T08:00:00.000Z",
  };

  it("returns null for a correct attempt", () => {
    expect(buildInterventionSummary({ ...wrongEvent, correct: true }, [])).toBeNull();
  });

  it("returns null when no error cause is reported", () => {
    expect(buildInterventionSummary({ ...wrongEvent, errorCause: null }, [])).toBeNull();
  });

  it("maps a low-confidence concept error to a review action with normal priority", () => {
    const summary = buildInterventionSummary(wrongEvent, []);
    expect(summary?.actionLabel).toBe("复习巩固");
    expect(summary?.priorityLabel).toBe("常规");
    expect(summary?.checkAtLabel).toBe("2026-08-21");
  });

  it("raises priority when the same cause repeated in history", () => {
    const history: AttemptEvent[] = [
      { ...wrongEvent, id: "77777777-7777-4777-8777-777777777702", errorCause: "concept" },
    ];
    expect(buildInterventionSummary(wrongEvent, history)?.priorityLabel).toBe("优先处理");
  });

  it("raises to focus priority for a high-confidence error", () => {
    expect(buildInterventionSummary({ ...wrongEvent, confidence: 5 }, [])?.priorityLabel).toBe("重点关注");
  });
});
