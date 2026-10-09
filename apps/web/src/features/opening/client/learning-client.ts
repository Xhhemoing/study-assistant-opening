import {
  learningSummarySchema,
  courseLearningSummaryInputSchema, courseLearningSummaryPageSchema,
  learningSessionCreateInputSchema, learningAttemptCreateInputSchema, learningAttemptSubmitInputSchema, learningAttemptSchema, learningObservationSchema,
  type LearningSessionCreateInput, type LearningAttemptCreateInput, type LearningAttemptSubmitInput,
  observationInputSchema,
  observationHistorySchema, observationRevisionInputSchema, observationRevisionResultSchema,
  type ObservationRevisionInput,
  type LearningSummary, type CourseLearningSummaryInput,
  type ObservationInput,
} from "@aistudy/contracts";
import { z } from "zod";
import { OpeningApiError } from "./api";

type FetchLike = typeof fetch;

function requestError(body: unknown, status: number): OpeningApiError {
  if (body && typeof body === "object" && "error" in body) {
    const error = (body as { error?: { message?: unknown; code?: unknown } }).error;
    if (error && typeof error.message === "string") return new OpeningApiError(status, error.message, typeof error.code === "string" ? error.code : null);
  }
  return new OpeningApiError(status, `request failed (${status})`);
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
  if (!res.ok) throw requestError(body, res.status);
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

    /** Fixed-snapshot, complete group summary. Legacy getSummary remains available. */
    async getSummaryPage(input: CourseLearningSummaryInput, signal?: AbortSignal) {
      const target = courseLearningSummaryInputSchema.parse(input);
      const query = new URLSearchParams({ limit: String(target.limit) });
      if (target.groupCursor !== undefined) query.set("groupCursor", target.groupCursor);
      const body = await request(`/api/opening/courses/${target.courseId}/learning/summary?${query}`, { method: "GET", signal }, fetchImpl);
      return courseLearningSummaryPageSchema.parse(body);
    },

    async listObservations(courseId: string) {
      return z.array(learningObservationSchema).parse(await request(`/api/opening/courses/${courseId}/observations`, { method: "GET" }, fetchImpl));
    },

    async getObservationHistory(id: string) {
      return observationHistorySchema.parse(await request(`/api/opening/observations/${id}/history`, { method: "GET" }, fetchImpl));
    },

    async reviseObservation(input: ObservationRevisionInput) {
      const payload = observationRevisionInputSchema.parse(input);
      return observationRevisionResultSchema.parse(await request("/api/opening/observations/revisions", { method: "POST", body: JSON.stringify(payload) }, fetchImpl));
    },

    async listRevisionCourses() {
      const result = await request("/api/courses", { method: "GET" }, fetchImpl);
      return z.object({ courses: z.array(z.object({ id: z.string().uuid(), title: z.string() })) }).parse(result).courses;
    },

    async createSession(input: LearningSessionCreateInput): Promise<{ id: string }> {
      const payload = learningSessionCreateInputSchema.parse(input);
      const body = await request("/api/opening/learning-sessions", { method: "POST", body: JSON.stringify(payload) }, fetchImpl);
      return z.object({ id: z.string().uuid() }).parse(body);
    },

    async createAttempt(input: LearningAttemptCreateInput) {
      const payload = learningAttemptCreateInputSchema.parse(input);
      return learningAttemptSchema.parse(await request("/api/opening/attempts", { method: "POST", body: JSON.stringify(payload) }, fetchImpl));
    },

    async getAttempt(attemptId: string) {
      const body = await request(`/api/opening/attempts/${attemptId}`, { method: "GET" }, fetchImpl);
      return z.object({
        attemptId: z.string().uuid(),
        sessionId: z.string().uuid(),
        deliveredAssistance: z.enum(["none", "hinted", "revealed"]),
      }).strict().parse(body);
    },

    async submitAttempt(attemptId: string, input: LearningAttemptSubmitInput) {
      const payload = learningAttemptSubmitInputSchema.parse(input);
      return learningObservationSchema.extend({ allowsIndependent: z.boolean() }).parse(await request(`/api/opening/attempts/${attemptId}/submit`, { method: "POST", body: JSON.stringify(payload) }, fetchImpl));
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
