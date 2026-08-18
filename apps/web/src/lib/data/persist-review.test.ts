import { afterEach, describe, expect, it, vi } from "vitest";
import { gradeReviewResponseSchema } from "@aistudy/contracts";
import { createMockProvider } from "./mock/provider";
import type { StorageLike } from "./mock/storage";
import { withPersistedReviews } from "./persist-review";

function memoryStorage(): StorageLike {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

const now = "2026-08-15T12:00:00.000Z";
const eventId = "55555555-5555-4555-8555-555555555555";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("withPersistedReviews", () => {
  it("creates the card then grades through the public API before updating local state", async () => {
    const provider = createMockProvider({
      userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      storage: memoryStorage(),
      delayMs: 0,
    });
    const due = await provider.listDueCards();
    const item = due[0];
    expect(item).toBeDefined();
    if (!item) return;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/cards" && init?.method === "POST") {
        return new Response(JSON.stringify({ card: item.card }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "/api/reviews" && init?.method === "POST") {
        return new Response(
          JSON.stringify(
            gradeReviewResponseSchema.parse({
              state: {
                ...item.state,
                reps: 1,
                lastGrade: "good",
                intervalDays: 1,
                dueAt: now,
                updatedAt: now,
              },
              event: {
                id: eventId,
                workspaceId: "22222222-2222-4222-8222-222222222222",
                ownerUserId: item.card.ownerUserId,
                type: "review",
                schemaVersion: 1,
                idempotencyKey: "review-persist-001",
                occurredAt: now,
                createdAt: now,
                contentId: item.card.id,
                contentVersion: 1,
                syllabusPointId: item.card.syllabusPointId,
                correctsEventId: null,
                payload: { grade: "good", assisted: false, excludeFromAssessment: false },
              },
            }),
          ),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("missing", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const localGrade = vi.spyOn(provider, "gradeCard");
    const result = await withPersistedReviews(provider).gradeCard(item.card.id, "good", {
      idempotencyKey: "review-persist-001",
    });

    expect(fetchMock).toHaveBeenCalled();
    expect(result.reps).toBe(1);
    expect(result.lastGrade).toBe("good");
    expect(localGrade).not.toHaveBeenCalled();
    const createBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body));
    expect(createBody.cardId).toBe(item.card.id);
  });

  it("loads the auto queue from the public API after ensuring local cards exist", async () => {
    const provider = createMockProvider({
      userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      storage: memoryStorage(),
      delayMs: 0,
    });
    const due = await provider.listDueCards();
    const item = due[0];
    expect(item).toBeDefined();
    if (!item) return;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/cards" && init?.method === "POST") {
          return new Response(JSON.stringify({ card: item.card }), {
            status: 201,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.startsWith("/api/reviews?mode=auto")) {
          return new Response(
            JSON.stringify({ items: [{ card: item.card, state: item.state, goalPriority: 4 }] }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("missing", { status: 404 });
      }),
    );

    const queue = await withPersistedReviews(provider).listDueCards();
    expect(queue).toHaveLength(1);
    expect(queue[0]?.card.id).toBe(item.card.id);
  });

  it("does not update local review state when the API grade fails", async () => {
    const provider = createMockProvider({
      userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      storage: memoryStorage(),
      delayMs: 0,
    });
    const due = await provider.listDueCards();
    const item = due[0];
    expect(item).toBeDefined();
    if (!item) return;

    const localGrade = vi.spyOn(provider, "gradeCard");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === "/api/cards") {
          return new Response(JSON.stringify({ card: item.card }), { status: 201 });
        }
        if (String(input) === "/api/reviews" && init?.method === "POST") {
          return new Response("boom", { status: 500 });
        }
        return new Response("missing", { status: 404 });
      }),
    );

    await expect(
      withPersistedReviews(provider).gradeCard(item.card.id, "good", {
        idempotencyKey: "review-persist-002",
      }),
    ).rejects.toThrow();
    expect(localGrade).not.toHaveBeenCalled();
  });
});
