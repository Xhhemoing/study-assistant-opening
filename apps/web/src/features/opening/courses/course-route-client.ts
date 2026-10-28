import { z } from "zod";
import { courseRouteActionResultSchema, courseRouteConfirmSchema, courseRouteNextSchema, courseRouteSnapshotSchema, courseRouteStartSchema, courseRouteRetestScheduleSchema, courseRouteRetestReceiptSchema, courseRouteTaskContextSchema, courseRouteVerificationReadSchema, courseRouteVerificationConfirmSchema, type CourseRouteVerificationConfirm, type CourseRouteConfirm, type CourseRouteNext, type CourseRouteStart, type CourseRouteRetestSchedule } from "@aistudy/contracts";
import { createSessionFetch } from "../../auth/session-expiry";
export class CourseRouteRequestError extends Error { constructor(message: string, readonly status: number) { super(message); } }
export function courseRouteHref(courseId: string, href: string): string {
  const prefix = `/opening/courses/${encodeURIComponent(courseId)}`;
  if (!href.startsWith("/") || href.startsWith("//") || /[\\\s]/.test(href)) throw new Error("学习入口不匹配，请重新读取课程路线。");
  const parsed = new URL(href, "https://aistudy.local");
  if (parsed.origin !== "https://aistudy.local" || (parsed.pathname !== prefix && !parsed.pathname.startsWith(`${prefix}/`))) throw new Error("学习入口不属于本课程。");
  return href;
}
export function createCourseRouteClient(transport: typeof fetch = (input, init) => fetch(input, init)) {
  const fetcher = createSessionFetch(transport);
  async function request<T>(courseId: string, suffix: string, schema: z.ZodType<T>, method = "GET", body?: unknown) {
    const response = await fetcher(`/api/opening/courses/${encodeURIComponent(courseId)}/learning-route${suffix}`, { method, cache: "no-store", ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    if (!response.ok) { const value = await response.json().catch(() => null); const message = z.union([z.object({ message: z.string() }), z.object({ error: z.object({ message: z.string() }) }).transform(value => value.error)]).safeParse(value); throw new CourseRouteRequestError(message.success ? message.data.message : "课程路线操作未完成，请重新读取。", response.status); }
    return schema.parse(await response.json());
  }
  async function action(courseId: string, suffix: string, body: unknown) {
    const result = await request(courseId, suffix, courseRouteActionResultSchema, "POST", body);
    courseRouteHref(courseId, result.href);
    if (result.kind === "ready" && (result.activity.courseId !== courseId || result.href !== `/opening/courses/${courseId}/study?activity=${result.activity.id}`)) throw new Error("学习活动与当前课程不匹配，请保留本页并重新确认这次安排。");
    if (result.kind === "choice" && result.courseId !== courseId) throw new Error("返回的课程选择与当前课程不匹配。");
    return result;
  }
  return {
    async read(courseId: string, activityId?: string) { const result = await request(courseId, activityId ? `?activityId=${encodeURIComponent(activityId)}` : "", courseRouteSnapshotSchema); if (result.courseId !== courseId || (activityId && result.currentActivity?.id !== activityId)) throw new Error("课程路线位置不匹配，请重新读取。"); return result; },
    confirm: async (courseId: string, input: CourseRouteConfirm) => request(courseId, "", courseRouteSnapshotSchema, "PUT", courseRouteConfirmSchema.parse(input)),
    start: async (courseId: string, input: CourseRouteStart) => action(courseId, "/start", courseRouteStartSchema.parse(input)),
    next: async (courseId: string, input: CourseRouteNext) => action(courseId, "/next", courseRouteNextSchema.parse(input)),
    async scheduleRetest(courseId: string, input: CourseRouteRetestSchedule) { const receipt = await request(courseId, "/retest", courseRouteRetestReceiptSchema, "POST", courseRouteRetestScheduleSchema.parse(input)); if (receipt.courseId !== courseId || receipt.href !== `/opening/courses/${courseId}/study?task=${receipt.taskId}`) throw new Error("复测安排结果与本课程不匹配。"); return receipt; },
    async task(courseId: string, taskId: string) { const result = await request(courseId, `/task?taskId=${encodeURIComponent(taskId)}`, courseRouteTaskContextSchema); if (result.managed && (result.courseId !== courseId || result.taskId !== taskId)) throw new Error("路线任务不属于当前课程。"); return result; },
    async verification(courseId: string, activityId: string) { const result = await request(courseId, `/verification?activityId=${encodeURIComponent(activityId)}`, courseRouteVerificationReadSchema); if (result.courseId !== courseId || result.activityId !== activityId) throw new Error("核对题目不属于当前课程活动。"); return result; },
    async confirmVerification(courseId: string, input: CourseRouteVerificationConfirm) { const result = await request(courseId, "/verification", courseRouteSnapshotSchema, "POST", courseRouteVerificationConfirmSchema.parse(input)); if (result.courseId !== courseId) throw new Error("确认结果不属于当前课程。"); return result; },
  };
}
export type CourseRouteClient = ReturnType<typeof createCourseRouteClient>;
