import { describe, expect, it } from "vitest";
import type { ReviewCard, ReviewState } from "@aistudy/contracts";
import {
  buildReviewQueue,
  isCardEligibleForMode,
  reviewEligibilityForMode,
} from "./eligibility";

const NOW = new Date("2026-08-15T12:00:00.000Z");
const TODAY = "2026-08-15";

function card(overrides: Partial<ReviewCard> = {}): ReviewCard {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    ownerUserId: "22222222-2222-4222-8222-222222222222",
    front: "front",
    back: "back",
    sourceDocumentId: null,
    syllabusPointId: null,
    tags: ["t"],
    archived: false,
    contentVersion: 1,
    pausedUntil: null,
    maintainUntil: null,
    excludeFromAssessment: false,
    createdAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function state(overrides: Partial<ReviewState> = {}): ReviewState {
  return {
    cardId: "11111111-1111-4111-8111-111111111111",
    ease: 2.5,
    intervalDays: 1,
    dueAt: "2026-08-14T12:00:00.000Z",
    reps: 1,
    lapses: 0,
    lastGrade: "good",
    updatedAt: "2026-08-14T12:00:00.000Z",
    ...overrides,
  };
}

describe("review eligibility and queue", () => {
  it("excludes archived cards in every mode", () => {
    const archived = card({ archived: true });
    for (const mode of ["auto", "self-selected", "free"] as const) {
      expect(isCardEligibleForMode(archived, state(), mode, NOW, TODAY)).toBe(false);
    }
  });

  it("excludes paused cards while pausedUntil is in the future", () => {
    const paused = card({ pausedUntil: "2026-08-20T00:00:00.000Z" });
    for (const mode of ["auto", "self-selected", "free"] as const) {
      expect(isCardEligibleForMode(paused, state(), mode, NOW, TODAY)).toBe(false);
    }
    expect(
      isCardEligibleForMode(
        card({ pausedUntil: "2026-08-15T11:00:00.000Z" }),
        state(),
        "auto",
        NOW,
        TODAY,
      ),
    ).toBe(true);
  });

  it("treats maintainUntil as auto-only maintain deadline", () => {
    const maintained = card({ maintainUntil: "2026-08-15" });
    const expired = card({ maintainUntil: "2026-08-14" });
    expect(isCardEligibleForMode(maintained, state(), "auto", NOW, TODAY)).toBe(true);
    expect(isCardEligibleForMode(expired, state(), "auto", NOW, TODAY)).toBe(false);
    expect(isCardEligibleForMode(expired, state(), "self-selected", NOW, TODAY)).toBe(true);
    expect(isCardEligibleForMode(expired, state(), "free", NOW, TODAY)).toBe(true);
  });

  it("lets excludeFromAssessment mark results without blocking review", () => {
    const excluded = card({ excludeFromAssessment: true });
    const result = reviewEligibilityForMode(excluded, state(), "auto", NOW, TODAY);
    expect(result.eligible).toBe(true);
    expect(result.excludeFromAssessment).toBe(true);
  });

  it("applies dueAt only in auto mode", () => {
    const future = state({ dueAt: "2026-08-16T12:00:00.000Z" });
    expect(isCardEligibleForMode(card(), future, "auto", NOW, TODAY)).toBe(false);
    expect(isCardEligibleForMode(card(), future, "self-selected", NOW, TODAY)).toBe(true);
    expect(isCardEligibleForMode(card(), future, "free", NOW, TODAY)).toBe(true);
  });

  it("sorts queue by dueAt, goal priority desc, then card id", () => {
    const a = {
      card: card({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
      state: state({
        cardId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        dueAt: "2026-08-14T10:00:00.000Z",
      }),
      goalPriority: 1,
    };
    const b = {
      card: card({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }),
      state: state({
        cardId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        dueAt: "2026-08-14T10:00:00.000Z",
      }),
      goalPriority: 5,
    };
    const c = {
      card: card({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }),
      state: state({
        cardId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        dueAt: "2026-08-13T10:00:00.000Z",
      }),
      goalPriority: 9,
    };
    const queue = buildReviewQueue([a, b, c], "auto", NOW, TODAY);
    expect(queue.map((item) => item.card.id)).toEqual([
      c.card.id,
      b.card.id,
      a.card.id,
    ]);
    expect(queue[0]?.state).toEqual(c.state);
  });
});
