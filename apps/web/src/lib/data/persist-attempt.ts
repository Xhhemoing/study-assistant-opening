import { submitAttemptResponseSchema } from "@aistudy/contracts";
import type { AttemptInput, StudyDataProvider } from "./types";

export async function persistAttempt(input: AttemptInput) {
  if (!input.practiceSessionId) {
    throw new Error("作答提交失败");
  }
  const response = await fetch("/api/attempts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      practiceSessionId: input.practiceSessionId,
      answer: input.answer,
      confidence: input.confidence,
      errorCause: input.errorCause,
      idempotencyKey: input.idempotencyKey,
    }),
  });
  if (!response.ok) throw new Error("作答提交失败");
  return submitAttemptResponseSchema.parse(await response.json()).event;
}

export function withPersistedAttempts(provider: StudyDataProvider): StudyDataProvider {
  return {
    ...provider,
    async submitAttempt(input) {
      if (!input.practiceSessionId) {
        return provider.submitAttempt(input);
      }
      const item = await provider.getPracticeItem(input.practiceItemId);
      if (!item) throw new Error("练习题不存在");
      const event = await persistAttempt(input);
      const local = await provider.submitAttempt({ ...input, eventId: event.id });
      return { event, status: local.status };
    },
  };
}
