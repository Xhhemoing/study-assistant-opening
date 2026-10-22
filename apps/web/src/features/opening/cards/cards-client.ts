import { acknowledgeStudyExposureHeaders } from "../assistant/study-exposure-ack";
import { createSessionFetch } from "../../auth/session-expiry";
import {
  createCardRequestSchema,
  cardVariantReviewSchema,
  createCardResponseSchema,
  observationCardDraftSchema,
  type CreateCardRequest,
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
  if (body !== null) acknowledgeStudyExposureHeaders(res, fetchImpl);
  return body;
}

export type OpeningCreateCardInput = CreateCardRequest;

export type OpeningGradeCardInput = {
  cardId: string;
  grade: ReviewGrade;
  idempotencyKey: string;
};

/** HTTP cards/reviews client. Failures throw; they never become sample cards. */
export function createOpeningCardsClient(transport: FetchLike = fetch) {
  const fetchImpl = createSessionFetch(transport);
  return {
    async startVariant(cardId: string, retry = false) {
      return cardVariantReviewSchema.parse(await request(`/api/cards/${encodeURIComponent(cardId)}/variant`, {
        method: "POST", body: JSON.stringify({ action: retry ? "retry" : "start" }),
      }, fetchImpl));
    },
    async completeVariant(cardId: string, observationId: string): Promise<GradeReviewResponse> {
      const result = gradeReviewResponseSchema.parse(await request(`/api/cards/${encodeURIComponent(cardId)}/variant`, {
        method: "POST", body: JSON.stringify({ action: "complete", observationId }),
      }, fetchImpl));
      if (typeof window !== "undefined") window.dispatchEvent(new Event("opening:reviews-changed"));
      return result;
    },
    async classify(cardId: string, reviewKind: "question" | "concept") {
      await request(`/api/cards/${encodeURIComponent(cardId)}/variant`, {
        method: "POST", body: JSON.stringify({ action: "classify", reviewKind }),
      }, fetchImpl);
    },
    async observationDraft(observationId: string) {
      return observationCardDraftSchema.parse(await request(
        `/api/opening/observations/${encodeURIComponent(observationId)}/card-draft`, { method: "GET" }, fetchImpl,
      ));
    },
    async createCard(input: OpeningCreateCardInput): Promise<CreateCardResponse> {
      const body = await request(
        "/api/cards",
        {
          method: "POST",
          body: JSON.stringify(createCardRequestSchema.parse(input)),
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
      const result = gradeReviewResponseSchema.parse(body);
      if (typeof window !== "undefined") window.dispatchEvent(new Event("opening:reviews-changed"));
      return result;
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
