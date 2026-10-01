import { courseLearningSummaryInputSchema } from "@aistudy/contracts";
import { ApiError } from "../../auth/service";

/** HTTP query boundary; a cursor belongs to the complete group page, never its representatives. */
export function parseCourseLearningSummaryRequest(courseId: string, query: URLSearchParams) {
  for (const key of query.keys()) {
    if (!["limit", "groupCursor"].includes(key) || query.getAll(key).length !== 1) {
      throw new ApiError("VALIDATION", "摘要查询参数无效或重复。", 400);
    }
  }
  const limit = query.get("limit");
  if (limit !== null && !/^\d+$/.test(limit)) throw new ApiError("VALIDATION", "每页分组数必须是 1 到 50 的整数。", 400);
  return courseLearningSummaryInputSchema.parse({ courseId,
    ...(limit !== null ? { limit: Number(limit) } : {}),
    ...(query.has("groupCursor") ? { groupCursor: query.get("groupCursor") } : {}),
  });
}
