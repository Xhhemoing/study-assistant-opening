import { courseLearningHistoryInputSchema, courseLearningHistoryPageSchema, type CourseLearningHistoryInput } from "@aistudy/contracts";
import { OpeningApiError } from "./api";

type HistoryRequest = Omit<CourseLearningHistoryInput, "limit"> & { limit?: number };
export function createCourseHistoryClient(fetchImpl: typeof fetch = fetch) {
  return {
    async getHistory(input: HistoryRequest) {
      const target = courseLearningHistoryInputSchema.parse(input);
      const query = new URLSearchParams({ limit: String(target.limit) });
      if (target.requirementKey === null) query.set("requirement", "unassigned");
      else if (target.requirementKey !== undefined) query.set("requirementKey", target.requirementKey);
      if (target.cursor !== undefined) query.set("cursor", target.cursor);
      const response = await fetchImpl(`/api/opening/courses/${target.courseId}/observations/history?${query}`, { method: "GET" });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const error = body && typeof body === "object" && "error" in body ? body.error : null;
        const message = error && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message : "课程历史暂时无法读取";
        const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : null;
        throw new OpeningApiError(response.status, message, code);
      }
      return courseLearningHistoryPageSchema.parse(body);
    },
  };
}
