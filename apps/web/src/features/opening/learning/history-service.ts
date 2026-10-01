import { courseLearningHistoryInputSchema } from "@aistudy/contracts";
import { ApiError } from "../../auth/service";

/** HTTP query boundary: preserve opaque cursors and distinguish all/null/exact requirements. */
export function parseCourseLearningHistoryRequest(courseId: string, query: URLSearchParams) {
  const allowed = new Set(["limit", "cursor", "requirement", "requirementKey"]);
  for (const key of query.keys()) {
    if (!allowed.has(key) || query.getAll(key).length !== 1) throw new ApiError("VALIDATION", "历史查询参数无效或重复。", 400);
  }
  if (query.has("requirement") && (query.has("requirementKey") || query.get("requirement") !== "unassigned")) {
    throw new ApiError("VALIDATION", "历史要求筛选无效。", 400);
  }
  const limit = query.get("limit");
  if (limit !== null && !/^\d+$/.test(limit)) throw new ApiError("VALIDATION", "每页条数必须是 1 到 200 的整数。", 400);
  return courseLearningHistoryInputSchema.parse({
    courseId,
    ...(limit !== null ? { limit: Number(limit) } : {}),
    ...(query.has("cursor") ? { cursor: query.get("cursor") } : {}),
    ...(query.has("requirement") ? { requirementKey: null } : query.has("requirementKey") ? { requirementKey: query.get("requirementKey") } : {}),
  });
}
