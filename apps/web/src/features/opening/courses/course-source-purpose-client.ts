import { z } from "zod";
import { createSessionFetch } from "../../auth/session-expiry";

// Thin UI boundary until the source-purpose contract owner hands back its export.
export const courseSourcePurposeSchema = z.enum(["teaching", "practice", "mock_exam", "reference"]).nullable();
export type CourseSourcePurpose = z.infer<typeof courseSourcePurposeSchema>;
const membershipSchema = z.object({
  id: z.string().uuid(), courseId: z.string().uuid(), assetType: z.literal("source"),
  assetId: z.string().uuid(), purpose: courseSourcePurposeSchema,
  updatedAt: z.string().datetime({ offset: true }),
});
export type CourseSourceMembership = z.infer<typeof membershipSchema>;
export const sourcePurposeLabels = {
  teaching: "教学材料", practice: "练习材料", mock_exam: "模考材料", reference: "仅作引用",
};
export function sourcePurposeLabel(purpose: CourseSourcePurpose): string {
  return purpose === null ? "未分类" : sourcePurposeLabels[purpose];
}
export const SOURCE_PURPOSE_HELP = "教学材料用于教学；练习材料用于练习，不自动当作教材；模考材料不参与教学；引用材料仅作引用，不生成练习。未分类表示尚未指定用途，不等于教学材料。";
export const SOURCE_PURPOSE_SCOPE = "用途仅影响本课程，不改变其他课程中的同一材料；不删除资料、成绩、历史作答或曝光记录。保存不会开始课程或生成内容；实际使用由服务端按用途校验，页面提示不能替代后端隔离。";

export class CourseSourcePurposeError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(status === 409 || code === "CONFLICT" ? "材料用途已变化，请刷新核对后重新确认；未覆盖他人修改。"
      : status === 403 ? "没有权限修改这份材料的课程用途。"
      : status === 401 ? "登录状态已过期，请重新登录。"
      : status === 404 ? "课程或材料已不存在，或不可访问。"
      : "用途操作未完成，结果尚未确认；请刷新核对，不会自动重试。");
    this.name = "CourseSourcePurposeError";
  }
}
const failureSchema = z.object({ error: z.object({ code: z.string() }) });
export function createCourseSourcePurposeClient(transport: typeof fetch = (input, init) => fetch(input, init)) {
  const fetcher = createSessionFetch(transport);
  async function request(courseId: string, suffix: string, method = "GET", body?: unknown) {
    const response = await fetcher(`/api/courses/${encodeURIComponent(courseId)}/${suffix}`, {
      method, cache: "no-store",
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const parsed = failureSchema.safeParse(await response.json().catch(() => null));
      throw new CourseSourcePurposeError(response.status, parsed.success ? parsed.data.error.code : "REQUEST_FAILED");
    }
    return response.json() as Promise<unknown>;
  }
  function membership(value: unknown, courseId: string, sourceId: string) {
    const row = membershipSchema.parse(value);
    if (row.courseId !== courseId || row.assetId !== sourceId) throw new Error("材料用途响应与本课程不匹配，请刷新核对。");
    return row;
  }
  return {
    async read(courseId: string, sourceId: string): Promise<CourseSourceMembership> {
      const body = z.object({ assets: z.array(z.object({ assetType: z.string(), assetId: z.string() }).passthrough()) })
        .parse(await request(courseId, "assets"));
      return membership(body.assets.find(row => row.assetType === "source" && row.assetId === sourceId), courseId, sourceId);
    },
    async add(courseId: string, sourceId: string, role: "core" | "optional" | "reference", purpose: CourseSourcePurpose) {
      const body = z.object({ membership: z.unknown() }).parse(await request(courseId, "memberships", "POST", {
        assetType: "source", assetId: sourceId, role, visibility: "private", sortOrder: 0, purpose,
      }));
      const row = membership(body.membership, courseId, sourceId);
      if (row.purpose !== purpose) throw new Error("服务端尚未确认所选用途，请刷新核对，不会自动重试。");
      return row;
    },
    async update(courseId: string, current: CourseSourceMembership, purpose: CourseSourcePurpose) {
      if (current.courseId !== courseId) throw new Error("不能将其他课程的用途确认用于本课程。");
      const body = z.object({ membership: z.unknown() }).parse(await request(courseId, "memberships", "PATCH", {
        assetType: "source", assetId: current.assetId, purpose, expectedUpdatedAt: current.updatedAt,
      }));
      const row = membership(body.membership, courseId, current.assetId);
      if (row.purpose !== purpose || new Date(row.updatedAt).getTime() <= new Date(current.updatedAt).getTime()) {
        throw new Error("服务端尚未确认用途更新，请刷新核对，不会自动重试。");
      }
      return row;
    },
  };
}
export type CourseSourcePurposeClient = ReturnType<typeof createCourseSourcePurposeClient>;
