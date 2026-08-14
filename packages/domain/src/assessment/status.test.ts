import { describe, expect, it } from "vitest";
import {
  ASSESSMENT_VERSION,
  deriveStatus,
  reviewGradeToEvidence,
  type EvidenceEvent,
  type StatusCorrection,
} from "./status";

const NOW = new Date("2026-08-02T08:00:00.000Z");
const POINT = "11111111-1111-4111-8111-111111111101";

function ev(partial: Partial<EvidenceEvent> & { occurredAt: string }): EvidenceEvent {
  return {
    correct: true,
    assisted: false,
    hintCount: 0,
    confidence: 4,
    slice: "recognition",
    source: "attempt",
    ...partial,
  };
}

describe("deriveStatus assess-1", () => {
  it("untested with zero events", () => {
    const r = deriveStatus(POINT, [], NOW);
    expect(r.status).toBe("untested");
    expect(r.reasonCodes).toEqual(["insufficient-evidence"]);
    expect(r.summaryMetrics).toEqual([
      { key: "coverage", label: "证据覆盖", value: "有效证据 0/6" },
      { key: "recentAccuracy", label: "近期正确率", value: "—" },
    ]);
    expect(r.recommendedActions).toEqual([
      { code: "baseline", label: "做2道基础识别题", estimatedMinutes: 10 },
    ]);
    expect(r.strategyVersion).toBe(ASSESSMENT_VERSION);
    expect(r.modelVersion).toBe("rules-1");
    expect(r.evidenceSnapshotId.startsWith("snap-")).toBe(true);
    expect(r.computedAt).toBe(NOW.toISOString());
  });

  it("assisted events do not count as effective evidence", () => {
    const r = deriveStatus(
      POINT,
      [
        ev({ occurredAt: "2026-08-01T08:00:00.000Z", assisted: true }),
        ev({ occurredAt: "2026-08-01T09:00:00.000Z" }),
      ],
      NOW,
    );
    expect(r.status).toBe("untested");
    expect(r.summaryMetrics[0].value).toBe("有效证据 1/6");
  });

  it("weak when latest effective event is incorrect", () => {
    const r = deriveStatus(
      POINT,
      [
        ev({ occurredAt: "2026-08-01T08:00:00.000Z" }),
        ev({ occurredAt: "2026-08-01T09:00:00.000Z", correct: false, confidence: 5 }),
      ],
      NOW,
    );
    expect(r.status).toBe("weak");
    expect(r.reasonCodes).toEqual(["recent-failure"]);
    expect(r.recommendedActions).toEqual([
      { code: "hint-steps", label: "步骤提示题", estimatedMinutes: 8 },
      { code: "no-hint-variant", label: "无提示变式", estimatedMinutes: 12 },
    ]);
  });

  it("weak adds low-confidence and hint-dependent when thresholds met", () => {
    const r = deriveStatus(
      POINT,
      [
        ev({ occurredAt: "2026-08-01T08:00:00.000Z", confidence: 1, hintCount: 2 }),
        ev({ occurredAt: "2026-08-01T09:00:00.000Z", confidence: 2, hintCount: 2 }),
        ev({ occurredAt: "2026-08-01T10:00:00.000Z", correct: false, confidence: 2, hintCount: 1 }),
      ],
      NOW,
    );
    expect(r.status).toBe("weak");
    expect(r.reasonCodes).toEqual(["recent-failure", "low-confidence", "hint-dependent"]);
  });

  it("stable requires transfer evidence plus a confident streak", () => {
    const events = [
      ev({ occurredAt: "2026-08-01T08:00:00.000Z", slice: "transfer" }),
      ev({ occurredAt: "2026-08-01T09:00:00.000Z" }),
      ev({ occurredAt: "2026-08-01T10:00:00.000Z" }),
      ev({ occurredAt: "2026-08-01T11:00:00.000Z" }),
    ];
    const r = deriveStatus(POINT, events, NOW);
    expect(r.status).toBe("stable");
    expect(r.reasonCodes).toEqual(["consistent-success"]);
    expect(r.recommendedActions).toEqual([
      { code: "maintain-transfer", label: "保持节奏：1道迁移题", estimatedMinutes: 12 },
    ]);
    expect(r.summaryMetrics[1].value).toBe("100%");
  });

  it("a same-slice streak without transfer is usable, not stable", () => {
    const events = [
      ev({ occurredAt: "2026-08-01T08:00:00.000Z" }),
      ev({ occurredAt: "2026-08-01T09:00:00.000Z" }),
      ev({ occurredAt: "2026-08-01T10:00:00.000Z" }),
      ev({ occurredAt: "2026-08-01T11:00:00.000Z" }),
    ];
    const r = deriveStatus(POINT, events, NOW);
    expect(r.status).toBe("usable");
    expect(r.reasonCodes).toEqual(["partial-mastery"]);
    expect(r.recommendedActions).toEqual([
      { code: "variant", label: "1道变式题巩固", estimatedMinutes: 10 },
    ]);
  });

  it("usable for short correct history below the stable threshold", () => {
    const r = deriveStatus(
      POINT,
      [
        ev({ occurredAt: "2026-08-01T08:00:00.000Z", correct: false }),
        ev({ occurredAt: "2026-08-01T09:00:00.000Z" }),
      ],
      NOW,
    );
    expect(r.status).toBe("usable");
    expect(r.summaryMetrics[1].value).toBe("50%");
  });

  it("deterministic output for identical input", () => {
    const events = [ev({ occurredAt: "2026-08-01T08:00:00.000Z" })];
    expect(deriveStatus(POINT, events, NOW)).toEqual(deriveStatus(POINT, events, NOW));
  });

  it("orders out-of-order events by occurrence time, not insertion order", () => {
    const r = deriveStatus(
      POINT,
      [
        ev({ occurredAt: "2026-08-01T09:00:00.000Z", correct: false }),
        ev({ occurredAt: "2026-08-01T08:00:00.000Z" }),
      ],
      NOW,
    );
    expect(r.status).toBe("weak");
  });
});

describe("reviewGradeToEvidence", () => {
  it("maps grades to recall-slice evidence", () => {
    const t = "2026-08-01T08:00:00.000Z";
    expect(reviewGradeToEvidence("again", t)).toEqual({
      correct: false,
      assisted: false,
      hintCount: 0,
      confidence: 1,
      slice: "recall",
      occurredAt: t,
      source: "review",
    });
    expect(reviewGradeToEvidence("hard", t).correct).toBe(true);
    expect(reviewGradeToEvidence("hard", t).confidence).toBe(2);
    expect(reviewGradeToEvidence("good", t).confidence).toBe(3);
    expect(reviewGradeToEvidence("easy", t).confidence).toBe(5);
  });
});

describe("review evidence affects status", () => {
  it("review-only recall history derives usable instead of untested", () => {
    const r = deriveStatus(
      POINT,
      [
        reviewGradeToEvidence("good", "2026-08-01T08:00:00.000Z"),
        reviewGradeToEvidence("good", "2026-08-01T09:00:00.000Z"),
      ],
      NOW,
    );
    expect(r.status).toBe("usable");
    expect(r.reasonCodes).toEqual(["partial-mastery"]);
  });

  it("a recent failed review marks the point weak", () => {
    const r = deriveStatus(
      POINT,
      [
        reviewGradeToEvidence("good", "2026-08-01T08:00:00.000Z"),
        reviewGradeToEvidence("again", "2026-08-01T09:00:00.000Z"),
      ],
      NOW,
    );
    expect(r.status).toBe("weak");
  });
});

describe("correction override", () => {
  const overrideCorrection: StatusCorrection = {
    syllabusPointId: POINT,
    note: "我觉得应该是稳固",
    overrideStatus: "stable",
    createdAt: "2026-08-02T07:00:00.000Z",
  };

  it("override replaces the derived status and surfaces the note", () => {
    const r = deriveStatus(
      POINT,
      [ev({ occurredAt: "2026-08-01T09:00:00.000Z", correct: false })],
      NOW,
      [overrideCorrection],
    );
    expect(r.status).toBe("stable");
    expect(r.reasonCodes[0]).toBe("user-correction");
    expect(r.summaryMetrics.some((m) => m.key === "correction" && m.value === "我觉得应该是稳固")).toBe(true);
  });

  it("a note-only correction disputes but keeps the derived status", () => {
    const r = deriveStatus(
      POINT,
      [
        ev({ occurredAt: "2026-08-01T08:00:00.000Z" }),
        ev({ occurredAt: "2026-08-01T09:00:00.000Z", correct: false }),
      ],
      NOW,
      [{ syllabusPointId: POINT, note: "标记不准确", overrideStatus: null, createdAt: "2026-08-02T07:00:00.000Z" }],
    );
    expect(r.status).toBe("weak");
    expect(r.reasonCodes).toContain("user-disputed");
    expect(r.summaryMetrics.some((m) => m.key === "correction")).toBe(true);
  });
});
