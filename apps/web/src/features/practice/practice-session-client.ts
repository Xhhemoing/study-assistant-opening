import {
  requestHintResponseSchema,
  revealAnswerResponseSchema,
  startPracticeResponseSchema,
  type PublicPracticeItem,
} from "@aistudy/contracts";

export async function startPracticeSession(
  itemId: string,
): Promise<{ sessionId: string; item: PublicPracticeItem } | null> {
  const response = await fetch(`/api/practice/${encodeURIComponent(itemId)}`, { method: "POST" });
  if (!response.ok) return null;
  const parsed = startPracticeResponseSchema.parse(await response.json());
  if ("answerRule" in parsed.item || "answer" in parsed.item) {
    throw new Error("Practice start response must not include grading secrets");
  }
  return parsed;
}

export async function requestPracticeHint(itemId: string, sessionId: string) {
  const response = await fetch(`/api/practice/${encodeURIComponent(itemId)}/hint`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
  if (!response.ok) throw new Error("提示请求失败");
  return requestHintResponseSchema.parse(await response.json());
}

export async function revealPracticeAnswer(itemId: string, sessionId: string) {
  const response = await fetch(`/api/practice/${encodeURIComponent(itemId)}/reveal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
  if (!response.ok) throw new Error("答案揭示失败");
  return revealAnswerResponseSchema.parse(await response.json());
}
