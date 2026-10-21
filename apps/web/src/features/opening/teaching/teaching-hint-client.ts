import { teachingHintRequestSchema, teachingHintResponseSchema, type LearningAttempt, type TeachingHintLevel, type TeachingHintResponse } from "@aistudy/contracts";
import { z } from "zod";
import { OpeningApiError } from "../client/api";

export const TEACHING_HINT_LABELS: Record<TeachingHintLevel, string> = { 1: "方向提示", 2: "概念提醒", 3: "第一步", 4: "参考解答" };
export type TeachingHintContext = { activityId: string; blockId: string; contentVersion: number };
export async function requestTeachingHint(attempt: Pick<LearningAttempt, "id" | "courseId" | "itemVersionId">, context: TeachingHintContext, level: TeachingHintLevel, fetcher: typeof fetch = fetch): Promise<TeachingHintResponse> {
  const response = await fetcher("/api/opening/teaching/hint", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(teachingHintRequestSchema.parse({ attemptId: attempt.id, level })) });
  const body: unknown = await response.json();
  if (!response.ok) {
    const error = z.object({ error: z.object({ message: z.string() }) }).safeParse(body);
    throw new OpeningApiError(response.status, error.success ? error.data.error.message : "提示尚未确认交付，原答案保留，可重试。");
  }
  const parsed = teachingHintResponseSchema.safeParse(body);
  if (!parsed.success) throw new Error("提示回执暂无法核实，原答案保留；请重试。");
  const hint = parsed.data, receipt = hint.exposureReceipt, anchor = receipt.contextAnchor;
  if (hint.attemptId !== attempt.id || hint.level !== level || anchor.attemptId !== attempt.id
    || anchor.courseId !== attempt.courseId || anchor.itemVersionId !== attempt.itemVersionId
    || anchor.activityId !== context.activityId || anchor.blockId !== context.blockId || anchor.contentVersion !== context.contentVersion
    || receipt.supportDomain === "language" || !receipt.releasedAt
    || receipt.origin !== (level === 4 ? "history_solution" : "assistant")
    || anchor.purpose !== (level === 4 ? "history_solution" : "learning_help")
    || level !== 4 && hint.referenceSourceId !== null) {
    throw new Error("提示回执与当前题目或级别不一致，已停止显示。原答案保留。");
  }
  return hint;
}
