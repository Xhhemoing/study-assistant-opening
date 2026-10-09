import {
  createCardResponseSchema,
  gradeReviewResponseSchema,
  listReviewQueueResponseSchema,
  type CreateCardResponse,
  type GradeReviewResponse,
  type ReviewGrade,
  type ReviewQueueItem,
  type ReviewQueueMode,
} from "@aistudy/contracts";
import { OpeningApiError } from "../client/api";

type FetchLike = typeof fetch;

function requestError(body: unknown, status: number): OpeningApiError {
  if (body && typeof body === "object" && "error" in body) {
    const error = (body as { error?: { message?: unknown; code?: unknown } }).error;
    if (error && typeof error.message === "string") {
      return new OpeningApiError(status, error.message, typeof error.code === "string" ? error.code : null);
    }
  }
  return new OpeningApiError(status, `request failed (${status})`);
}

async function request(path: string, init: RequestInit, fetchImpl: FetchLike): Promise<unknown> {
  const res = await fetchImpl(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!res.ok) throw requestError(body, res.status);
  return body;
}

export type OpeningCreateCardInput = {
  front: string;
  back: string;
  sourceDocumentId: string;
};

export type OpeningGradeCardInput = {
  cardId: string;
  grade: ReviewGrade;
  idempotencyKey: string;
};

/** HTTP cards/reviews client. Failures throw; they never become sample cards. */
export function createOpeningCardsClient(fetchImpl: FetchLike = fetch) {
  return {
    async createCard(input: OpeningCreateCardInput): Promise<CreateCardResponse> {
      const body = await request(
        "/api/cards",
        {
          method: "POST",
          body: JSON.stringify({
            front: input.front,
            back: input.back,
            sourceDocumentId: input.sourceDocumentId,
          }),
        },
        fetchImpl,
      );
      return createCardResponseSchema.parse(body);
    },

    async listDue(mode: ReviewQueueMode = "auto"): Promise<ReviewQueueItem[]> {
      const body = await request(
        `/api/reviews?mode=${encodeURIComponent(mode)}`,
        { method: "GET" },
        fetchImpl,
      );
      return listReviewQueueResponseSchema.parse(body).items;
    },

    async grade(input: OpeningGradeCardInput): Promise<GradeReviewResponse> {
      const body = await request(
        "/api/reviews",
        {
          method: "POST",
          body: JSON.stringify({
            cardId: input.cardId,
            grade: input.grade,
            idempotencyKey: input.idempotencyKey,
          }),
        },
        fetchImpl,
      );
      return gradeReviewResponseSchema.parse(body);
    },
  };
}

export type OpeningCardsClient = ReturnType<typeof createOpeningCardsClient>;

export type CardGradeIdentity = {
  fingerprint: string;
  key: string;
};

/** Bind one idempotency key to a card+grade intent so retries reuse it. */
export function resolveCardGradeIdentity(
  current: CardGradeIdentity | null,
  cardId: string,
  grade: ReviewGrade,
  createKey: () => string,
): CardGradeIdentity {
  const fingerprint = `${cardId}:${grade}`;
  if (current && current.fingerprint === fingerprint) return current;
  return { fingerprint, key: createKey() };
}
