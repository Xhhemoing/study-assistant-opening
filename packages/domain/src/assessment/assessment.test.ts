import { describe, expect, it } from "vitest";
import type { LearningEvent } from "@aistudy/contracts";
import { evidenceFromLearningEvent } from "./from-events";
import { deriveStatus, type EvidenceEvent } from "./status";

const NOW = new Date("2026-08-15T12:00:00.000Z");
const POINT = "11111111-1111-4111-8111-111111111101";

function ev(partial: Partial<EvidenceEvent> & { occurredAt: string }): EvidenceEvent {
  return {
    correct: true,
    assisted: false,
    hintCount: 0,
    confidence: 4,
    slice: "recognition",
    source: "attempt",
    excludeFromAssessment: false,
    ...partial,
  };
}

describe("contextual assessment slices and replay", () => {
  it("returns untested with assessment-disabled when the course or goal disables assessment", () => {
    const result = deriveStatus(
      POINT,
      [ev({ occurredAt: "2026-08-14T12:00:00.000Z" }), ev({ occurredAt: "2026-08-14T13:00:00.000Z" })],
      NOW,
      [],
      { assessmentMode: "disabled" },
    );
    expect(result.status).toBe("untested");
    expect(result.reasonCodes).toEqual(["assessment-disabled"]);
    expect(result.evidenceSnapshotId.startsWith("snap-")).toBe(true);
  });

  it("ignores evidence from disabled slices and excluded reviews", () => {
    const result = deriveStatus(
      POINT,
      [
        ev({ occurredAt: "2026-08-14T10:00:00.000Z", slice: "procedure" }),
        ev({ occurredAt: "2026-08-14T11:00:00.000Z", slice: "expression" }),
        ev({ occurredAt: "2026-08-14T12:00:00.000Z", excludeFromAssessment: true }),
        ev({ occurredAt: "2026-08-14T13:00:00.000Z" }),
      ],
      NOW,
      [],
      { disabledSlices: ["procedure", "expression"] },
    );
    expect(result.status).toBe("untested");
    expect(result.summaryMetrics[0]?.value).toBe("有效证据 1/6");
  });

  it("maps persisted attempt and review learning events onto the same evidence used for replay", () => {
    const attempt: LearningEvent = {
      id: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      ownerUserId: "33333333-3333-4333-8333-333333333333",
      type: "attempt",
      schemaVersion: 1,
      idempotencyKey: "attempt-assess-01",
      occurredAt: "2026-08-14T10:00:00.000Z",
      createdAt: "2026-08-14T10:00:00.000Z",
      contentId: "44444444-4444-4444-8444-444444444444",
      contentVersion: 1,
      syllabusPointId: POINT,
      correctsEventId: null,
      payload: {
        answer: "A",
        correct: true,
        assisted: false,
        durationMs: 4000,
        hintCount: 0,
        confidence: 4,
        errorCause: null,
        abilitySlice: "recall",
      },
    };
    const review: LearningEvent = {
      ...attempt,
      id: "55555555-5555-4555-8555-555555555555",
      type: "review",
      idempotencyKey: "review-assess-01",
      occurredAt: "2026-08-14T11:00:00.000Z",
      createdAt: "2026-08-14T11:00:00.000Z",
      payload: { grade: "good", assisted: false, excludeFromAssessment: false },
    };
    const excluded: LearningEvent = {
      ...review,
      id: "66666666-6666-4666-8666-666666666666",
      idempotencyKey: "review-assess-02",
      payload: { grade: "again", assisted: false, excludeFromAssessment: true },
    };

    const events = [attempt, review, excluded]
      .map(evidenceFromLearningEvent)
      .filter((item): item is EvidenceEvent => item !== null);
    const first = deriveStatus(POINT, events, NOW);
    const second = deriveStatus(POINT, events, NOW);
    expect(first).toEqual(second);
    expect(first.status).toBe("usable");
    expect(events).toHaveLength(2);
  });

  it("covers recognition, recall, procedure, transfer, and expression as distinct slices", () => {
    const slices = ["recognition", "recall", "procedure", "transfer", "expression"] as const;
    const result = deriveStatus(
      POINT,
      slices.map((slice, index) =>
        ev({
          occurredAt: `2026-08-14T1${index}:00:00.000Z`,
          slice,
        }),
      ),
      NOW,
      [],
      { disabledSlices: ["expression"] },
    );
    expect(result.status).toBe("stable");
    expect(result.summaryMetrics[0]?.value).toBe("有效证据 4/6");
  });

  it("adds timed-unstable when recent evidence failed under time pressure", () => {
    const result = deriveStatus(POINT, [
      ev({ occurredAt: "2026-08-14T10:00:00.000Z" }),
      ev({ occurredAt: "2026-08-14T11:00:00.000Z", correct: false, errorCause: "time" }),
    ], NOW);
    expect(result.status).toBe("weak");
    expect(result.reasonCodes).toContain("timed-unstable");
  });

  it("downgrades stable to usable when last evidence is older than the retention window", () => {
    const result = deriveStatus(POINT, [
      ev({ occurredAt: "2026-07-01T08:00:00.000Z", slice: "transfer" }),
      ev({ occurredAt: "2026-07-01T09:00:00.000Z" }),
      ev({ occurredAt: "2026-07-01T10:00:00.000Z" }),
      ev({ occurredAt: "2026-07-01T11:00:00.000Z" }),
    ], NOW);
    expect(result.status).toBe("usable");
    expect(result.reasonCodes).toContain("retention-gap");
  });

  it("skips timed and retention rules when those slices are disabled", () => {
    const timed = deriveStatus(
      POINT,
      [
        ev({ occurredAt: "2026-08-14T10:00:00.000Z" }),
        ev({ occurredAt: "2026-08-14T11:00:00.000Z", correct: false, errorCause: "time" }),
      ],
      NOW,
      [],
      { disabledSlices: ["timed"] },
    );
    expect(timed.status).toBe("weak");
    expect(timed.reasonCodes).not.toContain("timed-unstable");

    const retention = deriveStatus(
      POINT,
      [
        ev({ occurredAt: "2026-07-01T08:00:00.000Z", slice: "transfer" }),
        ev({ occurredAt: "2026-07-01T09:00:00.000Z" }),
        ev({ occurredAt: "2026-07-01T10:00:00.000Z" }),
        ev({ occurredAt: "2026-07-01T11:00:00.000Z" }),
      ],
      NOW,
      [],
      { disabledSlices: ["retention"] },
    );
    expect(retention.status).toBe("stable");
    expect(retention.reasonCodes).not.toContain("retention-gap");
  });
});
