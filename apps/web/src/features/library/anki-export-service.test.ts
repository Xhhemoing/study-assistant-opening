import { describe, expect, it, vi } from "vitest";
import { CardRepositoryError } from "@aistudy/database";
import type { Principal } from "../../lib/authorization";
import { exportAnkiForPrincipal } from "./anki-export-service";

const workspaceId = "22222222-2222-4222-8222-222222222222";
const otherWorkspace = "33333333-3333-4333-8333-333333333333";
const ownerUserId = "11111111-1111-4111-8111-111111111111";
const cardId = "44444444-4444-4444-8444-444444444444";
const documentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const principal = { userId: ownerUserId, workspaceId } as Principal;

const card = {
  id: cardId,
  ownerUserId,
  front: "导数 ![图](media/graph.png)",
  back: "极限定义",
  sourceDocumentId: documentId,
  syllabusPointId: "55555555-5555-4555-8555-555555555555",
  tags: ["高数"],
  archived: false,
  contentVersion: 1,
  pausedUntil: null,
  maintainUntil: null,
  excludeFromAssessment: false,
  createdAt: "2026-08-15T00:00:00.000Z",
};

const state = {
  cardId,
  ease: 2.5,
  intervalDays: 1,
  dueAt: "2026-08-16T00:00:00.000Z",
  reps: 1,
  lapses: 0,
  lastGrade: "good",
  updatedAt: "2026-08-15T12:00:00.000Z",
};

describe("anki export service", () => {
  it("exports from the session workspace and ignores a client workspace id", async () => {
    const getCard = vi.fn().mockResolvedValue(card);
    const getState = vi.fn().mockResolvedValue(state);
    const listRelations = vi.fn().mockResolvedValue([]);
    const getByDocumentTarget = vi.fn().mockResolvedValue(null);
    const result = await exportAnkiForPrincipal(
      {
        cards: { getCard, getState, listCards: vi.fn() },
        library: { listRelations },
        promotions: { getByDocumentTarget },
      } as never,
      principal,
      { cardId, workspaceId: otherWorkspace },
    );
    expect(getCard).toHaveBeenCalledWith({ workspaceId, cardId });
    expect(result.format).toBe("anki");
    expect(result.lossReport.claimedLossless).toBe(false);
    expect(result.notes[0]?.fields.Front).toContain("导数");
    expect(result.notes[0]?.fields.Source).toContain(documentId);
    expect(result.scheduling[0]?.factor).toBe(2500);
    expect(result.manifest.media[0]?.href).toBe("media/graph.png");
  });

  it("refuses to export a card that belongs to another workspace", async () => {
    const getCard = vi.fn().mockRejectedValue(new CardRepositoryError("NOT_FOUND", "missing"));
    await expect(
      exportAnkiForPrincipal(
        { cards: { getCard, getState: vi.fn(), listCards: vi.fn() }, library: { listRelations: vi.fn() }, promotions: { getByDocumentTarget: vi.fn() } } as never,
        principal,
        { cardId },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("records course requirements, exploration provenance, relations, and review history as losses", async () => {
    const result = await exportAnkiForPrincipal(
      {
        cards: {
          getCard: vi.fn().mockResolvedValue(card),
          getState: vi.fn().mockResolvedValue(state),
          listCards: vi.fn(),
        },
        library: { listRelations: vi.fn().mockResolvedValue([{ id: "rel-1" }]) },
        promotions: { getByDocumentTarget: vi.fn().mockResolvedValue({ id: "promo-1" }) },
      } as never,
      principal,
      { cardId },
    );
    expect(result.lossReport.losses.map((loss) => loss.code).sort()).toEqual([
      "course-requirements",
      "exploration-provenance",
      "relations",
      "review-history",
    ]);
  });
});
