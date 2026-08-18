import { describe, expect, it, vi } from "vitest";
import type { LearningEvent, ReviewCard, ReviewState } from "@aistudy/contracts";
import type { Principal } from "../../lib/authorization";
import {
  createCardForPrincipal,
  gradeReviewForPrincipal,
  listReviewQueueForPrincipal,
  updateCardControlsForPrincipal,
} from "./review-service";

const workspaceId = "22222222-2222-4222-8222-222222222222";
const ownerUserId = "33333333-3333-4333-8333-333333333333";
const cardId = "44444444-4444-4444-8444-444444444444";
const now = "2026-08-15T12:00:00.000Z";

const principal = { userId: ownerUserId, workspaceId } as Principal;

const card: ReviewCard = {
  id: cardId,
  ownerUserId,
  front: "导数",
  back: "极限定义",
  sourceDocumentId: null,
  syllabusPointId: null,
  tags: ["高数"],
  archived: false,
  contentVersion: 1,
  pausedUntil: null,
  maintainUntil: null,
  excludeFromAssessment: false,
  createdAt: now,
};

const state: ReviewState = {
  cardId,
  ease: 2.5,
  intervalDays: 1,
  dueAt: now,
  reps: 1,
  lapses: 0,
  lastGrade: "good",
  updatedAt: now,
};

const event: LearningEvent = {
  id: "55555555-5555-4555-8555-555555555555",
  workspaceId,
  ownerUserId,
  type: "review",
  schemaVersion: 1,
  idempotencyKey: "review-key-01",
  occurredAt: now,
  createdAt: now,
  contentId: cardId,
  contentVersion: 1,
  syllabusPointId: null,
  correctsEventId: null,
  payload: { grade: "good", assisted: false, excludeFromAssessment: false },
};

function runtime(cards: Record<string, ReturnType<typeof vi.fn>>) {
  return { cards } as never;
}

describe("review service", () => {
  it("grades through the card repository using the session principal workspace", async () => {
    const grade = vi.fn().mockResolvedValue({
      state: { ...state, workspaceId, ownerUserId },
      event,
      created: true,
    });
    const result = await gradeReviewForPrincipal(
      runtime({ grade }),
      principal,
      {
        cardId,
        grade: "good",
        idempotencyKey: "review-key-01",
        occurredAt: now,
        assisted: false,
      },
    );
    expect(grade).toHaveBeenCalledWith({
      workspaceId,
      ownerUserId,
      cardId,
      grade: "good",
      assisted: false,
      idempotencyKey: "review-key-01",
      occurredAt: now,
    });
    expect(result.state.reps).toBe(1);
    expect(result.event.id).toBe(event.id);
  });

  it("rejects a short idempotency key before touching the repository", async () => {
    const grade = vi.fn();
    await expect(
      gradeReviewForPrincipal(runtime({ grade }), principal, {
        cardId,
        grade: "good",
        idempotencyKey: "short",
      }),
    ).rejects.toThrow();
    expect(grade).not.toHaveBeenCalled();
  });

  it("lists the auto queue for the session workspace and ignores a client workspace id", async () => {
    const listQueue = vi.fn().mockResolvedValue([
      { card, state: { ...state, workspaceId, ownerUserId }, goalPriority: 4 },
    ]);
    const result = await listReviewQueueForPrincipal(
      runtime({ listQueue }),
      principal,
      { mode: "auto", workspaceId: "99999999-9999-4999-8999-999999999999" },
    );
    expect(listQueue).toHaveBeenCalledWith({
      workspaceId,
      ownerUserId,
      mode: "auto",
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.goalPriority).toBe(4);
  });

  it("creates a card owned by the session principal", async () => {
    const createCard = vi.fn().mockResolvedValue(card);
    const result = await createCardForPrincipal(runtime({ createCard }), principal, {
      cardId,
      front: "导数",
      back: "极限定义",
      tags: ["高数"],
    });
    expect(createCard).toHaveBeenCalledWith({
      workspaceId,
      ownerUserId,
      cardId,
      front: "导数",
      back: "极限定义",
      tags: ["高数"],
      sourceDocumentId: undefined,
      syllabusPointId: undefined,
    });
    expect(result.card.id).toBe(cardId);
  });

  it("updates card controls through the session workspace", async () => {
    const updateControls = vi.fn().mockResolvedValue({ ...card, archived: true });
    const result = await updateCardControlsForPrincipal(
      runtime({ updateControls }),
      principal,
      { cardId, archived: true },
    );
    expect(updateControls).toHaveBeenCalledWith({
      workspaceId,
      cardId,
      archived: true,
      pausedUntil: undefined,
      maintainUntil: undefined,
      excludeFromAssessment: undefined,
    });
    expect(result.card.archived).toBe(true);
  });
});
