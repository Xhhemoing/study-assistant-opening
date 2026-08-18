import { describe, expect, it, vi } from "vitest";
import type { LearningEvent } from "@aistudy/contracts";
import { LearningEventRepositoryError } from "@aistudy/database";
import type { AuthRuntime } from "../auth/service";
import {
  appendStatusCorrectionForPrincipal,
  listAssessmentForPrincipal,
  statusesFromEvents,
} from "./assessment-service";

const now = new Date("2026-08-15T12:00:00.000Z");
const workspaceId = "22222222-2222-4222-8222-222222222222";
const ownerUserId = "33333333-3333-4333-8333-333333333333";
const otherWorkspace = "44444444-4444-4444-8444-444444444444";
const pointA = "55555555-5555-4555-8555-555555555555";
const contentId = "77777777-7777-4777-8777-777777777777";
const principal = { userId: ownerUserId, workspaceId };

function attempt(id: string, pointId: string, occurredAt: string, extra: Partial<LearningEvent["payload"]> = {}): LearningEvent {
  return {
    id,
    workspaceId,
    ownerUserId,
    type: "attempt",
    schemaVersion: 1,
    idempotencyKey: `attempt-${id.slice(0, 8)}`,
    occurredAt,
    createdAt: occurredAt,
    contentId,
    contentVersion: 1,
    syllabusPointId: pointId,
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
      ...extra,
    },
  };
}

function review(id: string, pointId: string, occurredAt: string): LearningEvent {
  return {
    id,
    workspaceId,
    ownerUserId,
    type: "review",
    schemaVersion: 1,
    idempotencyKey: `review-${id.slice(0, 8)}`,
    occurredAt,
    createdAt: occurredAt,
    contentId,
    contentVersion: 1,
    syllabusPointId: pointId,
    correctsEventId: null,
    payload: { grade: "good", assisted: false, excludeFromAssessment: false },
  };
}

function correction(id: string, targetId: string, pointId: string, occurredAt: string): LearningEvent {
  return {
    id,
    workspaceId,
    ownerUserId,
    type: "correction",
    schemaVersion: 1,
    idempotencyKey: `correction-${id.slice(0, 8)}`,
    occurredAt,
    createdAt: occurredAt,
    contentId,
    contentVersion: 1,
    syllabusPointId: pointId,
    correctsEventId: targetId,
    payload: { kind: "status", note: "应为稳固", overrideStatus: "stable" },
  };
}

describe("statusesFromEvents", () => {
  it("replays attempt, review, and status correction onto one snapshot", () => {
    const first = attempt("11111111-1111-4111-8111-111111111111", pointA, "2026-08-14T10:00:00.000Z");
    const events = [
      first,
      review("11111111-1111-4111-8111-111111111112", pointA, "2026-08-14T11:00:00.000Z"),
      correction("11111111-1111-4111-8111-111111111113", first.id, pointA, "2026-08-14T12:00:00.000Z"),
    ];
    const [status] = statusesFromEvents(events, now);
    expect(status?.status).toBe("stable");
    expect(status?.reasonCodes[0]).toBe("user-correction");
    expect(status?.evidenceSnapshotId).toBe(statusesFromEvents(events, now)[0]?.evidenceSnapshotId);
  });

  it("excludes assisted evidence and disabled slices, then changes the snapshot when a late event arrives", () => {
    const assisted = attempt("11111111-1111-4111-8111-111111111111", pointA, "2026-08-14T10:00:00.000Z", {
      assisted: true,
      correct: false,
    });
    const transfer = attempt("11111111-1111-4111-8111-111111111112", pointA, "2026-08-14T11:00:00.000Z", {
      abilitySlice: "transfer",
    });
    const late = attempt("11111111-1111-4111-8111-111111111113", pointA, "2026-08-16T10:00:00.000Z");
    const filtered = statusesFromEvents([assisted, transfer], now, { disabledSlices: ["transfer"] });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.status).toBe("untested");
    const beforeLate = statusesFromEvents([assisted, transfer], now);
    const afterLate = statusesFromEvents([assisted, transfer, late], now);
    expect(afterLate[0]?.evidenceSnapshotId).not.toBe(beforeLate[0]?.evidenceSnapshotId);
    expect(afterLate[0]?.syllabusPointId).toBe(pointA);
  });
});

function runtimeWith(events: {
  listForOwner: AuthRuntime["learningEvents"]["listForOwner"];
  get?: AuthRuntime["learningEvents"]["get"];
  append?: AuthRuntime["learningEvents"]["append"];
}): AuthRuntime {
  return {
    learningEvents: {
      listForOwner: events.listForOwner,
      get: events.get ?? (async () => {
        throw new LearningEventRepositoryError("NOT_FOUND", "missing");
      }),
      append: events.append ?? (async () => {
        throw new Error("append should not be called");
      }),
      findByIdempotency: async () => null,
    },
  } as AuthRuntime;
}

describe("listAssessmentForPrincipal", () => {
  it("reads only the principal workspace and optional syllabus filter", async () => {
    const listForOwner = vi.fn().mockResolvedValue([
      attempt("11111111-1111-4111-8111-111111111111", pointA, "2026-08-14T10:00:00.000Z"),
    ]);
    const result = await listAssessmentForPrincipal(
      runtimeWith({ listForOwner }),
      principal,
      { syllabusPointId: pointA },
      now,
    );
    expect(listForOwner).toHaveBeenCalledWith({
      workspaceId,
      ownerUserId,
      syllabusPointId: pointA,
    });
    expect(result.statuses).toHaveLength(1);
    expect(result.statuses[0]?.syllabusPointId).toBe(pointA);
    await expect(
      listAssessmentForPrincipal(runtimeWith({ listForOwner }), principal, { workspaceId: otherWorkspace }),
    ).rejects.toThrow();
  });
});

describe("appendStatusCorrectionForPrincipal", () => {
  const target = attempt("11111111-1111-4111-8111-111111111111", pointA, "2026-08-14T10:00:00.000Z");

  it("hides another workspace's target and rejects a client-chosen workspace", async () => {
    const get = vi.fn().mockRejectedValue(
      new LearningEventRepositoryError("WORKSPACE_MISMATCH", "hidden"),
    );
    await expect(
      appendStatusCorrectionForPrincipal(
        runtimeWith({ listForOwner: async () => [], get }),
        principal,
        {
          correctsEventId: target.id,
          kind: "status",
          note: "应为稳固",
          idempotencyKey: "correction-hidden",
        },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      appendStatusCorrectionForPrincipal(
        runtimeWith({ listForOwner: async () => [], get: async () => target }),
        principal,
        {
          correctsEventId: target.id,
          kind: "status",
          note: "应为稳固",
          workspaceId: otherWorkspace,
          idempotencyKey: "correction-workspace",
        },
      ),
    ).rejects.toThrow();
  });

  it("appends in the principal workspace and returns the recomputed status", async () => {
    const stored = correction("11111111-1111-4111-8111-111111111114", target.id, pointA, now.toISOString());
    const append = vi.fn().mockResolvedValue(stored);
    const result = await appendStatusCorrectionForPrincipal(
      runtimeWith({
        listForOwner: async () => [target, stored],
        get: async () => target,
        append,
      }),
      principal,
      {
        correctsEventId: target.id,
        kind: "status",
        note: "应为稳固",
        overrideStatus: "stable",
        idempotencyKey: "correction-0001",
      },
      now,
    );
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        ownerUserId,
        type: "correction",
        correctsEventId: target.id,
        syllabusPointId: pointA,
      }),
    );
    expect(result.event.id).toBe(stored.id);
    expect(result.status.status).toBe("stable");
  });
});
