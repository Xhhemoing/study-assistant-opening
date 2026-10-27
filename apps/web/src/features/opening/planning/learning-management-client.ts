import { z } from "zod";
import { learningManagementCommandSchema, learningManagementOverviewSchema, learningManagementResultSchema, learningRecoveryCommandSchema, learningRecoveryResultSchema, learningLifecycleCommandSchema, learningLifecycleResultSchema, learningCardSessionCommandSchema, learningCardSessionSchema, learningMaintenanceStartSchema, courseRouteActionResultSchema } from "@aistudy/contracts";
import { courseRouteHref } from "../courses/course-route-client";
import { createSessionFetch } from "../../auth/session-expiry";
export class LearningManagementRequestError extends Error { constructor(message: string, readonly status: number) { super(message); } }
export function learningManagementHref(href: string) {
  if (!href.startsWith("/opening/") || /[\\\s]/.test(href) || !new URL(href, "https://aistudy.local").pathname.startsWith("/opening/")) throw new Error("学习恢复入口不匹配，请重新读取。");
  return href;
}
export function createLearningManagementClient(transport: typeof fetch = (input, init) => fetch(input, init)) {
  const fetcher = createSessionFetch(transport);
  async function request<T>(suffix: string, schema: z.ZodType<T>, body?: unknown) {
    const response = await fetcher(`/api/opening/planning/long-term${suffix}`, { method: body === undefined ? "GET" : "POST", cache: "no-store", ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    if (!response.ok) { const messageSchema = z.object({ message: z.string() }); const parsed = z.union([messageSchema, z.object({ error: messageSchema }).transform(value => value.error)]).safeParse(await response.json().catch(() => null)); throw new LearningManagementRequestError(parsed.success ? parsed.data.message : "学习管理操作未完成，请重新核对。", response.status); }
    return schema.parse(await response.json());
  }
  return {
    async read(date: string) { const value = await request(`?date=${encodeURIComponent(date)}`, learningManagementOverviewSchema); if (value.recovery.href) learningManagementHref(value.recovery.href); value.cardSessions.forEach(session => learningManagementHref(session.href)); return value; },
    command: async (input: z.infer<typeof learningManagementCommandSchema>) => request("", learningManagementResultSchema, learningManagementCommandSchema.parse(input)),
    async recover(input: z.infer<typeof learningRecoveryCommandSchema>) { const value = await request("/recovery", learningRecoveryResultSchema, learningRecoveryCommandSchema.parse(input)); if ("href" in value) learningManagementHref(value.href); return value; },
    lifecycle: async (input: z.infer<typeof learningLifecycleCommandSchema>) => request("/lifecycle", learningLifecycleResultSchema, learningLifecycleCommandSchema.parse(input)),
    async maintenance(input: z.infer<typeof learningMaintenanceStartSchema>) { const result = await request("/maintenance", courseRouteActionResultSchema, learningMaintenanceStartSchema.parse(input)); const courseId = result.kind === "ready" ? result.activity.courseId : result.courseId; if (!courseId) throw new Error("保持抽查未关联课程，请重新读取。"); courseRouteHref(courseId, result.href); return result; },
    async cardSessions(activityId?: string) { const result = await request(`/card-session${activityId ? `?activityId=${encodeURIComponent(activityId)}` : ""}`, z.object({ sessions: z.array(learningCardSessionSchema) })); result.sessions.forEach(session => learningManagementHref(session.href)); return result.sessions; },
    async cardCommand(input: z.infer<typeof learningCardSessionCommandSchema>) { const result = await request("/card-session", learningCardSessionSchema, learningCardSessionCommandSchema.parse(input)); learningManagementHref(result.href); return result; },
  };
}
export type LearningManagementClient = ReturnType<typeof createLearningManagementClient>;
