import { courseLearningPreferencesUpdateSchema, learningPreferencesSchema, type CourseLearningPreferencesUpdate } from "@aistudy/contracts";
import { z } from "zod";
import type { CourseAsset, CourseSummary } from "./course-model";

const courseSchema = z.object({
  id: z.string().uuid(), title: z.string(), slug: z.string(), description: z.string(),
  createdAt: z.string(), updatedAt: z.string(), archivedAt: z.string().nullable(),
  learningPreferenceOverrides: courseLearningPreferencesUpdateSchema,
});
const preferencesResponse = z.object({ learningPreferences: learningPreferencesSchema });

export function createCourseStateClient(fetcher: typeof fetch = fetch) {
  async function request(path: string, method = "GET", body?: unknown): Promise<Response> {
    const response = await fetcher(path, {
      method, cache: "no-store",
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(response.status === 401
      ? "登录状态已过期，请重新登录。" : "操作未完成，请重试；你的内容仍保留。" );
    return response;
  }
  return {
    async getPreferences(courseId: string) {
      const response = await request(`/api/opening/courses/${encodeURIComponent(courseId)}/preferences`);
      return preferencesResponse.parse(await response.json()).learningPreferences;
    },
    async getAccountPreferences() {
      return preferencesResponse.parse(await (await request("/api/workspace/preferences")).json()).learningPreferences;
    },
    async savePreferences(courseId: string, value: CourseLearningPreferencesUpdate) {
      const response = await request(`/api/opening/courses/${encodeURIComponent(courseId)}/preferences`, "PUT", value);
      return preferencesResponse.parse(await response.json()).learningPreferences;
    },
    async setArchived(courseId: string, archived: boolean): Promise<CourseSummary> {
      const response = await request(`/api/courses/${encodeURIComponent(courseId)}`, "PATCH", { archived });
      return z.object({ course: courseSchema }).parse(await response.json()).course;
    },
    async removeAsset(courseId: string, asset: Pick<CourseAsset, "assetType" | "assetId">) {
      await request(`/api/courses/${encodeURIComponent(courseId)}/memberships`, "DELETE", { assetType: asset.assetType, assetId: asset.assetId });
    },
  };
}
