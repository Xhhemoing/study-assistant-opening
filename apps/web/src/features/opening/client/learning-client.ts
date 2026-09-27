import {
  learningSummarySchema,
  observationInputSchema,
  type LearningSummary,
  type ObservationInput,
} from "@aistudy/contracts";
import { z } from "zod";
import { OpeningApiError } from "./api";

type FetchLike = typeof fetch;

function errorMessage(body: unknown, status: number): string {
  if (body && typeof body === "object" && "error" in body) {
    const error = (body as { error?: { message?: unknown } }).error;
    if (error && typeof error.message === "string") return error.message;
  }
  return `request failed (${status})`;
}

async function request(
  path: string,
  init: RequestInit,
  fetchImpl: FetchLike,
): Promise<unknown> {
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
  if (!res.ok) throw new OpeningApiError(res.status, errorMessage(body, res.status));
  return body;
}

/** HTTP learning client. Failures throw; they never become demo summaries. */
export function createOpeningLearningClient(fetchImpl: FetchLike = fetch) {
  return {
    async getSummary(courseId: string): Promise<LearningSummary[]> {
      const body = await request(
        `/api/opening/courses/${courseId}/learning`,
        { method: "GET" },
        fetchImpl,
      );
      return z.array(learningSummarySchema).parse(body);
    },

    async submitObservation(input: ObservationInput) {
      const payload = observationInputSchema.parse(input);
      return request(
        "/api/opening/observations",
        { method: "POST", body: JSON.stringify(payload) },
        fetchImpl,
      );
    },
  };
}
