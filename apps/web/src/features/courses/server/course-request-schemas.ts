import "server-only";
import { z } from "zod";
import { ApiError } from "../../auth/service";

/** Request bodies for /api/courses handlers; messages are learner-facing Chinese. */
export const createCourseBodySchema = z.object({
  title: z.string({ error: "请填写课程名称。" }).trim().min(1, { error: "请填写课程名称。" }).max(500, { error: "课程名称不能超过 500 个字。" }),
  slug: z.string({ error: "请填写课程标识。" }).trim().min(1, { error: "请填写课程标识。" }).max(200, { error: "课程标识不能超过 200 个字符。" })
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, { error: "课程标识只能使用小写字母、数字和连字符。" }),
  description: z.string({ error: "课程简介格式不正确。" }).max(5000, { error: "课程简介不能超过 5000 个字。" }).optional(),
}, { error: "请求内容格式不正确。" });

const assetTypeSchema = z.enum(["source", "document", "block", "card"], { error: "资料类型不受支持。" });
const assetIdSchema = z.string({ error: "缺少资料编号。" }).uuid({ error: "资料编号格式不正确。" });

export const addMembershipBodySchema = z.object({
  assetType: assetTypeSchema,
  assetId: assetIdSchema,
  role: z.enum(["core", "optional", "reference", "archive"], { error: "资料在课程中的角色不正确。" }),
  sortOrder: z.number({ error: "排序值必须是整数。" }).int({ error: "排序值必须是整数。" }).optional(),
  visibility: z.enum(["private", "course", "public"], { error: "可见范围不正确。" }),
}, { error: "请求内容格式不正确。" });

export const removeMembershipBodySchema = z.object({ assetType: assetTypeSchema, assetId: assetIdSchema }, { error: "请求内容格式不正确。" });

export const courseIdParamSchema = z.string().uuid({ error: "课程编号格式不正确。" });

/** Parse with the first issue's Chinese message in the standard VALIDATION envelope. */
export function parseCourseRequest<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new ApiError("VALIDATION", parsed.error.issues[0]?.message ?? "请求内容格式不正确。", 400);
}

/** Malformed JSON gets the same Chinese envelope instead of the generic English message. */
export async function readCourseJson(request: Request): Promise<unknown> {
  try { return await request.json(); }
  catch { throw new ApiError("VALIDATION", "请求内容不是有效的 JSON。", 400); }
}
