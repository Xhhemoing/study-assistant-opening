import { describe, expect, it } from "vitest";
import type { LearningEvent } from "@aistudy/contracts";
import { correctionFromLearningEvent } from "./from-events";
import { disabledSlicesFromWeights } from "./slices";
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

function stableRun(lastAt: string): EvidenceEvent[] {
  return [
    ev({ occurredAt: "2026-08-01T08:00:00.000Z", slice: "transfer" }),
    ev({ occurredAt: "2026-08-01T09:00:00.000Z" }),
    ev({ occurredAt: "2026-08-01T10:00:00.000Z" }),
    ev({ occurredAt: lastAt }),
  ];
}

describe("assessment snapshot identity and contextual rules", () => {
  it("changes the snapshot when event bodies differ at the same timestamps", () => {
    const stamp = ["2026-08-14T10:00:00.000Z", "2026-08-14T11:00:00.000Z"] as const;
    const passed = deriveStatus(
      POINT,
      [ev({ occurredAt: stamp[0] }), ev({ occurredAt: stamp[1] })],
      NOW,
    );
    const failed = deriveStatus(
      POINT,
      [ev({ occurredAt: stamp[0], correct: false }), ev({ occurredAt: stamp[1] })],
      NOW,
    );
    expect(passed.evidenceSnapshotId).not.toBe(failed.evidenceSnapshotId);
  });

  it("includes as-of time so retention replay cannot reuse an old snapshot id", () => {
    const events = stableRun("2026-08-01T11:00:00.000Z");
    const fresh = deriveStatus(POINT, events, new Date("2026-08-10T12:00:00.000Z"));
    const stale = deriveStatus(POINT, events, NOW);
    expect(fresh.status).toBe("stable");
    expect(stale.status).toBe("usable");
    expect(fresh.evidenceSnapshotId).not.toBe(stale.evidenceSnapshotId);
  });

  it("caps stable at usable when an earlier windowed attempt failed under time pressure", () => {
    const result = deriveStatus(POINT, [
      ev({ occurredAt: "2026-08-14T08:00:00.000Z", correct: false, errorCause: "time" }),
      ev({ occurredAt: "2026-08-14T09:00:00.000Z", slice: "transfer" }),
      ev({ occurredAt: "2026-08-14T10:00:00.000Z" }),
      ev({ occurredAt: "2026-08-14T11:00:00.000Z" }),
      ev({ occurredAt: "2026-08-14T12:00:00.000Z" }),
    ], NOW);
    expect(result.status).toBe("usable");
    expect(result.reasonCodes).toContain("timed-unstable");
  });

  it("applies retention-gap only after the 14-day window", () => {
    const events = [
      ev({ occurredAt: "2026-08-01T08:00:00.000Z", slice: "transfer" }),
      ev({ occurredAt: "2026-08-01T09:00:00.000Z" }),
      ev({ occurredAt: "2026-08-01T10:00:00.000Z" }),
      ev({ occurredAt: "2026-08-01T12:00:00.000Z" }),
    ];
    const onWindow = deriveStatus(POINT, events, NOW);
    expect(onWindow.status).toBe("stable");
    expect(onWindow.reasonCodes).not.toContain("retention-gap");

    const pastWindow = deriveStatus(
      POINT,
      [...events.slice(0, 3), ev({ occurredAt: "2026-08-01T11:00:00.000Z" })],
      NOW,
    );
    expect(pastWindow.status).toBe("usable");
    expect(pastWindow.reasonCodes).toContain("retention-gap");
  });

  it("surfaces repeated-error-cause when the last three effective events share a cause", () => {
    const result = deriveStatus(POINT, [
      ev({ occurredAt: "2026-08-14T10:00:00.000Z", correct: false, errorCause: "concept" }),
      ev({ occurredAt: "2026-08-14T11:00:00.000Z", correct: false, errorCause: "concept" }),
      ev({ occurredAt: "2026-08-14T12:00:00.000Z", correct: false, errorCause: "concept" }),
    ], NOW);
    expect(result.status).toBe("weak");
    expect(result.reasonCodes).toContain("repeated-error-cause");
  });

  it("maps status correction learning events for replay", () => {
    const event: LearningEvent = {
      id: "77777777-7777-4777-8777-777777777777",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      ownerUserId: "33333333-3333-4333-8333-333333333333",
      type: "correction",
      schemaVersion: 1,
      idempotencyKey: "correction-assess-01",
      occurredAt: "2026-08-14T12:00:00.000Z",
      createdAt: "2026-08-14T12:00:00.000Z",
      contentId: null,
      contentVersion: null,
      syllabusPointId: POINT,
      correctsEventId: "11111111-1111-4111-8111-111111111111",
      payload: { kind: "status", note: "应为稳固", overrideStatus: "stable" },
    };
    expect(correctionFromLearningEvent(event)).toEqual({
      syllabusPointId: POINT,
      note: "应为稳固",
      overrideStatus: "stable",
      createdAt: "2026-08-14T12:00:00.000Z",
    });
  });

  it("disables slices whose course or goal weight is zero", () => {
    expect(
      disabledSlicesFromWeights({
        recognition: 25,
        recall: 25,
        procedural: 0,
        transfer: 25,
        expression: 15,
        timed: 10,
      }),
    ).toEqual(["procedure"]);
  });
});
