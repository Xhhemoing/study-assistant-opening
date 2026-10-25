import { spanHintRequestSchema, spanHintResponseSchema, type LearningAttempt, type SpanHintLevel, type SpanHintResponse } from "@aistudy/contracts";

export const SPAN_HINT_LABELS: Record<SpanHintLevel, string> = { 1: "方向提示", 2: "定义提醒", 3: "第一步", 4: "完整示范" };

export function nextSpanHintLevel(delivered: ReadonlyArray<Pick<SpanHintResponse, "level">>): SpanHintLevel | null {
  const latest = delivered.reduce<number>((value, hint) => Math.max(value, hint.level), 0);
  return latest < 4 ? (latest + 1) as SpanHintLevel : null;
}

/** Accept content only when its actual level and durable release belong to this question. */
export async function requestSpanHint(attempt: Pick<LearningAttempt, "id" | "itemVersionId" | "courseId">, level: SpanHintLevel, fetcher: typeof fetch = fetch): Promise<SpanHintResponse> {
  const response = await fetcher("/api/opening/teaching/span/hint", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(spanHintRequestSchema.parse({ attemptId: attempt.id, level })) });
  if (!response.ok) throw new Error("提示还没加载出来，你的答案还在，可以再点一次。");
  const parsed = spanHintResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("提示暂时没加载好，你的答案还在，可以再点一次。");
  const hint = parsed.data;
  const anchor = hint.exposureReceipt.contextAnchor;
  // Full demonstrations reuse the existing solution ledger; older releases have
  // an unknown domain. Their original identity must remain valid on retry.
  const deliveryKindMatches = level === 4
    ? hint.exposureReceipt.origin === "history_solution" && anchor.purpose === "history_solution" && hint.exposureReceipt.supportDomain !== "language"
    : hint.exposureReceipt.origin === "assistant" && anchor.purpose === "learning_help" && hint.exposureReceipt.supportDomain === "math";
  if (hint.attemptId !== attempt.id || hint.level !== level || anchor.attemptId !== attempt.id
    || anchor.itemVersionId !== attempt.itemVersionId || anchor.courseId !== attempt.courseId
    || !deliveryKindMatches || !hint.exposureReceipt.releasedAt) {
    throw new Error("这条提示和当前题目对不上，已先隐藏。你的答案还在，可以再点一次。");
  }
  return hint;
}
