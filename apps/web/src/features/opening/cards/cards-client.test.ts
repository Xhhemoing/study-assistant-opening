import { expect, it, vi } from "vitest";
import { createOpeningCardsClient, resolveCardGradeIdentity } from "./cards-client";
import { OpeningApiError } from "../client/api";

const CARD = "11111111-1111-4111-8111-111111111111";
const DOC = "22222222-2222-4222-8222-222222222222";
const OWNER = "33333333-3333-4333-8333-333333333333";
const WORKSPACE = "44444444-4444-4444-8444-444444444444";
const EVENT = "55555555-5555-4555-8555-555555555555";
const ISO = "2026-10-09T09:00:00.000Z";

const sampleCard = {
  id: CARD,
  ownerUserId: OWNER,
  front: "正面",
  back: "背面",
  sourceDocumentId: DOC,
  syllabusPointId: null,
  tags: [],
  archived: false,
  contentVersion: 1,
  pausedUntil: null,
  maintainUntil: null,
  excludeFromAssessment: false,
  createdAt: ISO,
};

const sampleState = {
  cardId: CARD,
  ease: 2.5,
  intervalDays: 1,
  dueAt: ISO,
  reps: 1,
  lapses: 0,
  lastGrade: "good" as const,
  updatedAt: ISO,
};

const sampleEvent = {
  id: EVENT,
  workspaceId: WORKSPACE,
  ownerUserId: OWNER,
  type: "review" as const,
  schemaVersion: 1,
  idempotencyKey: "review-key-01",
  occurredAt: ISO,
  createdAt: ISO,
  contentId: CARD,
  contentVersion: 1,
  syllabusPointId: null,
  correctsEventId: null,
  payload: { grade: "good" as const, assisted: false, excludeFromAssessment: false },
};

it("throws on 503 when listing due cards and never returns sample cards", async () => {
  const client = createOpeningCardsClient(async () => new Response("unavailable", { status: 503 }));
  await expect(client.listDue("auto")).rejects.toMatchObject({ status: 503 });
  await expect(client.listDue("auto")).rejects.toBeInstanceOf(OpeningApiError);
});

it("throws on 503 when creating or grading and does not invent a card", async () => {
  const client = createOpeningCardsClient(async () => new Response(JSON.stringify({ error: { message: "upstream down" } }), { status: 503 }));
  await expect(client.createCard({ front: "a", back: "b", sourceDocumentId: DOC })).rejects.toThrow("upstream down");
  await expect(client.grade({ cardId: CARD, grade: "good", idempotencyKey: "review-key-01" })).rejects.toBeInstanceOf(OpeningApiError);
});

it("posts create/list/grade to the real cards and reviews APIs", async () => {
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/cards") {
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ front: "问", back: "答", sourceDocumentId: DOC });
      return Response.json({ card: sampleCard }, { status: 201 });
    }
    if (url.startsWith("/api/reviews?")) {
      expect(url).toBe("/api/reviews?mode=auto");
      return Response.json({ items: [{ card: sampleCard, state: sampleState, goalPriority: 0 }] });
    }
    expect(url).toBe("/api/reviews");
    expect(JSON.parse(String(init?.body))).toEqual({
      cardId: CARD,
      grade: "good",
      idempotencyKey: "review-key-01",
    });
    return Response.json({ state: sampleState, event: sampleEvent }, { status: 201 });
  });
  const client = createOpeningCardsClient(fetchImpl as unknown as typeof fetch);
  expect((await client.createCard({ front: "问", back: "答", sourceDocumentId: DOC })).card.id).toBe(CARD);
  expect(await client.listDue("auto")).toEqual([{ card: sampleCard, state: sampleState, goalPriority: 0 }]);
  const graded = await client.grade({ cardId: CARD, grade: "good", idempotencyKey: "review-key-01" });
  expect(graded.state.cardId).toBe(CARD);
  expect(fetchImpl).toHaveBeenCalledWith(
    "/api/reviews",
    expect.objectContaining({ method: "POST", body: JSON.stringify({ cardId: CARD, grade: "good", idempotencyKey: "review-key-01" }) }),
  );
});

it("reuses the same idempotencyKey when retrying the same card grade intent", () => {
  const createKey = vi.fn(() => "minted-once");
  const first = resolveCardGradeIdentity(null, CARD, "good", createKey);
  const retried = resolveCardGradeIdentity(first, CARD, "good", () => "should-not-run");
  expect(retried).toEqual(first);
  expect(retried.key).toBe("minted-once");
  expect(createKey).toHaveBeenCalledTimes(1);

  const changed = resolveCardGradeIdentity(first, CARD, "hard", () => "new-key");
  expect(changed.key).toBe("new-key");
  expect(changed.fingerprint).toBe(`${CARD}:hard`);
});
