import type { LearningObservation } from "@aistudy/contracts";
import type { createOpeningLearningClient } from "../client/learning-client";

export type InlineAttemptIdentity = {
  activityId: string;
  courseId: string;
  blockId: string;
  contentVersion: number;
  sourceIds: string[];
  prompt: string;
  skillLabel: string;
  answer: string;
};
type LearningClient = ReturnType<typeof createOpeningLearningClient>;

/** Capture one answer and identity; a retry reuses the same attempt and write key. */
export function createInlineAttemptSubmission(input: InlineAttemptIdentity, client: Pick<LearningClient, "createSession" | "createAttempt" | "submitAttempt">) {
  const attemptKey = `teaching-attempt:${crypto.randomUUID()}`;
  const submitKey = `teaching-answer:${crypto.randomUUID()}`;
  let sessionId: string | null = null;
  let attemptId: string | null = null;
  let result: LearningObservation | null = null;
  let pending: Promise<{ attemptId: string; observation: LearningObservation }> | null = null;
  async function run() {
    if (result && attemptId) return { attemptId, observation: result };
    sessionId ??= (await client.createSession({ courseId: input.courseId, activityId: input.activityId, skillLabel: input.skillLabel, sourceIds: input.sourceIds })).id;
    if (!attemptId) {
      const sourceId = input.sourceIds[0];
      const attempt = await client.createAttempt({ sessionId, clientKey: attemptKey, teachingBlock: { blockId: input.blockId, contentVersion: input.contentVersion },
        ...(sourceId ? { problem: { sourceId, stemSnapshot: input.prompt.slice(0, 2000), artifactKind: "reference_item" as const } } : {}),
      });
      attemptId = attempt.id;
    }
    result = await client.submitAttempt(attemptId, { clientKey: submitKey, answer: input.answer, outcome: "unverified", assistance: "independent", verdictSource: "self_report" });
    return { attemptId, observation: result };
  }
  return {
    submit() {
      pending ??= run().finally(() => { pending = null; });
      return pending;
    },
  };
}
