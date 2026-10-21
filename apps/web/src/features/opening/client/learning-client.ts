import { parseOpeningResponse } from "./parse-response";
import { acknowledgeStudyExposureHeaders } from "../assistant/study-exposure-ack";
import { createSessionFetch } from "../../auth/session-expiry";
import {
  learningSummarySchema,
  courseLearningSummaryInputSchema, courseLearningSummaryPageSchema,
  learningSessionCreateInputSchema, learningAttemptCreateInputSchema, learningAttemptSubmitInputSchema, learningAttemptSchema, learningAttemptContextReadSchema, learningObservationSchema,
  type LearningSessionCreateInput, type LearningAttemptCreateInput, type LearningAttemptSubmitInput,
  observationInputSchema,
  aiGradingInputSchema, type AiGradingInput,
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
  if (body !== null) acknowledgeStudyExposureHeaders(res, fetchImpl);
  return body;
}

/** HTTP learning client. Failures throw; they never become demo summaries. */
export function createOpeningLearningClient(transport: FetchLike = fetch) {
  const fetchImpl = createSessionFetch(transport);
  return {
    async getSummary(courseId: string): Promise<LearningSummary[]> {
      const body = await request(
        `/api/opening/courses/${courseId}/learning`,
        { method: "GET" },
        fetchImpl,
      );
      return parseOpeningResponse(z.array(learningSummarySchema), body);
    },

    /** Fixed-snapshot, complete group summary. Legacy getSummary remains available. */
    async getSummaryPage(input: CourseLearningSummaryInput, signal?: AbortSignal) {
      const target = courseLearningSummaryInputSchema.parse(input);
      const query = new URLSearchParams({ limit: String(target.limit) });
      if (target.groupCursor !== undefined) query.set("groupCursor", target.groupCursor);
      const body = await request(`/api/opening/courses/${target.courseId}/learning/summary?${query}`, { method: "GET", signal }, fetchImpl);
      return parseOpeningResponse(courseLearningSummaryPageSchema, body);
    },

    async listObservations(courseId: string) {
      return parseOpeningResponse(z.array(learningObservationSchema), await request(`/api/opening/courses/${courseId}/observations`, { method: "GET" }, fetchImpl));
    },

    async getObservationHistory(id: string) {
      return parseOpeningResponse(observationHistorySchema, await request(`/api/opening/observations/${id}/history`, { method: "GET" }, fetchImpl));
    },

    async reviseObservation(input: ObservationRevisionInput) {
      const payload = observationRevisionInputSchema.parse(input);
      return parseOpeningResponse(observationRevisionResultSchema, await request("/api/opening/observations/revisions", { method: "POST", body: JSON.stringify(payload) }, fetchImpl));
    },

    async gradeObservation(input: AiGradingInput) {
      const payload = aiGradingInputSchema.parse(input);
      return parseOpeningResponse(learningObservationSchema, await request("/api/opening/observations/grade", { method: "POST", body: JSON.stringify(payload) }, fetchImpl));
    },

    async listRevisionCourses() {
      const result = await request("/api/courses", { method: "GET" }, fetchImpl);
      return parseOpeningResponse(z.object({ courses: z.array(z.object({ id: z.string().uuid(), title: z.string() })) }), result).courses;
    },

    async createSession(input: LearningSessionCreateInput): Promise<{ id: string }> {
      const payload = learningSessionCreateInputSchema.parse(input);
      const body = await request("/api/opening/learning-sessions", { method: "POST", body: JSON.stringify(payload) }, fetchImpl);
      return parseOpeningResponse(z.object({ id: z.string().uuid() }), body);
    },

    async createAttempt(input: LearningAttemptCreateInput) {
      const payload = learningAttemptCreateInputSchema.parse(input);
      return parseOpeningResponse(learningAttemptSchema, await request("/api/opening/attempts", { method: "POST", body: JSON.stringify(payload) }, fetchImpl));
    },

    async getAttempt(attemptId: string) {
      const body = await request(`/api/opening/attempts/${attemptId}`, { method: "GET" }, fetchImpl);
      return parseOpeningResponse(z.object({
        attemptId: z.string().uuid(),
        sessionId: z.string().uuid(),
        deliveredAssistance: z.enum(["none", "hinted", "revealed"]),
      }).strict(), body);
    },

    async getAttemptContext(attemptId: string) {
      return parseOpeningResponse(learningAttemptContextReadSchema, await request(`/api/opening/attempts/${encodeURIComponent(attemptId)}/context`, { method: "GET", cache: "no-store" }, fetchImpl));
    },

    async submitAttempt(attemptId: string, input: LearningAttemptSubmitInput) {
      const payload = learningAttemptSubmitInputSchema.parse(input);
      return parseOpeningResponse(learningObservationSchema.extend({ allowsIndependent: z.boolean() }), await request(`/api/opening/attempts/${attemptId}/submit`, { method: "POST", body: JSON.stringify(payload) }, fetchImpl));
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
