import { teachingHintRequestSchema, teachingHintResponseSchema, type LearningAttempt, type TeachingHintLevel, type TeachingHintResponse } from "@aistudy/contracts";
import { z } from "zod";
import { OpeningApiError } from "../client/api";

export const TEACHING_HINT_LABELS: Record<TeachingHintLevel, string> = { 1: "方向提示", 2: "概念提醒", 3: "第一步", 4: "参考解答" };
export type TeachingHintContext = { activityId: string; blockId: string; contentVersion: number };
type HintAttempt = Pick<LearningAttempt, "id" | "courseId" | "itemVersionId">;
async function readResponseBody(response: Response): Promise<unknown> {
  const body: unknown = await response.json();
  if (!response.ok) {
    const error = z.object({ error: z.object({ message: z.string() }) }).safeParse(body);
    throw new OpeningApiError(response.status, error.success ? error.data.error.message : "提示还没加载出来，你的答案还在，可以再点一次。");
  }
  return body;
}
function validateHint(hint: TeachingHintResponse, attempt: HintAttempt, context: TeachingHintContext): TeachingHintResponse {
  const level = hint.level, receipt = hint.exposureReceipt, anchor = receipt.contextAnchor;
  if (hint.attemptId !== attempt.id || anchor.attemptId !== attempt.id || receipt.releaseKey !== `teaching-hint-v1:${attempt.id}:${level}`
    || anchor.courseId !== attempt.courseId || anchor.itemVersionId !== attempt.itemVersionId
    || anchor.activityId !== context.activityId || anchor.blockId !== context.blockId || anchor.contentVersion !== context.contentVersion
    || receipt.supportDomain === "language" || !receipt.releasedAt
    || receipt.origin !== (level === 4 ? "history_solution" : "assistant")
    || anchor.purpose !== (level === 4 ? "history_solution" : "learning_help")
    || level !== 4 && hint.referenceSourceId !== null) {
    throw new Error("这条提示和当前题目对不上，已先隐藏。你的答案还在，可以再点一次。");
  }
  return hint;
}

export async function requestTeachingHint(attempt: HintAttempt, context: TeachingHintContext, level: TeachingHintLevel, fetcher: typeof fetch = fetch): Promise<TeachingHintResponse> {
  const response = await fetcher("/api/opening/teaching/hint", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(teachingHintRequestSchema.parse({ attemptId: attempt.id, level })) });
  const parsed = teachingHintResponseSchema.safeParse(await readResponseBody(response));
  if (!parsed.success || parsed.data.level !== level) throw new Error("提示暂时没加载好，你的答案还在，可以再点一次。");
  return validateHint(parsed.data, attempt, context);
}

/** Refresh recovery reads only already-released help; it never calls the delivery POST or acknowledges new exposure. */
export async function readReleasedTeachingHints(attempt: HintAttempt, context: TeachingHintContext, fetcher: typeof fetch = fetch): Promise<TeachingHintResponse[]> {
  const attemptId = teachingHintRequestSchema.shape.attemptId.parse(attempt.id);
  const response = await fetcher(`/api/opening/teaching/hint?${new URLSearchParams({ attemptId })}`, { cache: "no-store" });
  const parsed = z.object({ hints: z.array(teachingHintResponseSchema).max(4) }).strict().safeParse(await readResponseBody(response));
  if (!parsed.success || new Set(parsed.data.hints.map(hint => hint.level)).size !== parsed.data.hints.length) {
    throw new Error("之前看过的提示暂时没加载好，你的答案还在，可以稍后再试。");
  }
  return parsed.data.hints.map(hint => validateHint(hint, attempt, context)).sort((a, b) => a.level - b.level);
}
