import { describe, expect, it } from "vitest";
import { ASSESSMENT_VERSION, deriveStatus, type EvidenceEvent } from "./status";

const NOW = new Date("2026-08-02T08:00:00.000Z");
const POINT = "11111111-1111-4111-8111-111111111101";

function ev(partial: Partial<EvidenceEvent> & { occurredAt: string }): EvidenceEvent {
  return {
    correct: true,
    assisted: false,
    hintCount: 0,
    confidence: 4,
    slice: "recognition",
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
});
