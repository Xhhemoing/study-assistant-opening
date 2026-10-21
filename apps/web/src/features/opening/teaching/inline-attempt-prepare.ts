import type { LearningAttempt } from "@aistudy/contracts";
import { z } from "zod";
import type { createOpeningLearningClient } from "../client/learning-client";

export const inlineAttemptPreparationInputSchema = z.object({
  activityId: z.string().uuid(), courseId: z.string().uuid(), blockId: z.string().uuid(),
  contentVersion: z.number().int().positive(), sourceIds: z.array(z.string().uuid()).max(32),
  prompt: z.string().max(100_000), skillLabel: z.string().min(1).max(200),
}).strict();
export const inlineAttemptKeySchema = z.string().regex(/^teaching-attempt:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
/** No answer or qualification is captured until the learner actually submits. */
export const inlineAttemptPreparationCheckpointSchema = z.object({
  input: inlineAttemptPreparationInputSchema, attemptKey: inlineAttemptKeySchema,
  sessionId: z.string().uuid().nullable(), attemptId: z.string().uuid().nullable(),
}).strict().refine(value => !value.attemptId || Boolean(value.sessionId));
export type InlineAttemptPreparationInput = z.infer<typeof inlineAttemptPreparationInputSchema>;
export type InlineAttemptPreparationCheckpoint = z.infer<typeof inlineAttemptPreparationCheckpointSchema>;
type Client = Pick<ReturnType<typeof createOpeningLearningClient>, "createSession" | "createAttempt">;
type Preparation = { checkpoint: InlineAttemptPreparationCheckpoint; attempt: LearningAttempt | null; pending: Promise<LearningAttempt> | null };
const preparations = new Map<string, Preparation>();

export function assertInlinePreparedAttempt(captured: InlineAttemptPreparationCheckpoint, canonical: LearningAttempt) {
  if ((captured.attemptId && canonical.id !== captured.attemptId)
    || canonical.courseId !== captured.input.courseId || canonical.sessionId !== captured.sessionId
    || canonical.requirementKey !== `teaching:${captured.input.blockId}:v${captured.input.contentVersion}`) {
    throw new Error("作答记录与当前课程或题目不一致，原答案和请求已保留，请重新读取活动。");
  }
}

export function createInlineAttemptPreparation(input: InlineAttemptPreparationInput, client: Client,
  options: { checkpoint?: InlineAttemptPreparationCheckpoint; onCheckpoint: (checkpoint: InlineAttemptPreparationCheckpoint) => void }) {
  const checkpoint = options.checkpoint ?? { input: { ...input, sourceIds: [...input.sourceIds] }, attemptKey: `teaching-attempt:${crypto.randomUUID()}`, sessionId: null, attemptId: null };
  const cached = preparations.get(checkpoint.attemptKey);
  const state = cached && JSON.stringify(cached.checkpoint.input) === JSON.stringify(checkpoint.input)
    ? cached : { checkpoint, attempt: null, pending: null };
  if (!cached) preparations.set(checkpoint.attemptKey, state);
  const publish = () => options.onCheckpoint({ ...state.checkpoint, input: { ...state.checkpoint.input, sourceIds: [...state.checkpoint.input.sourceIds] } });
  async function run() {
    if (state.attempt) return state.attempt;
    const captured = state.checkpoint, identity = captured.input;
    if (!captured.sessionId) {
      captured.sessionId = (await client.createSession({ courseId: identity.courseId, activityId: identity.activityId, skillLabel: identity.skillLabel, sourceIds: identity.sourceIds })).id;
      publish();
    }
    const sourceId = identity.sourceIds[0];
    const canonical = await client.createAttempt({ sessionId: captured.sessionId, clientKey: captured.attemptKey,
      teachingBlock: { blockId: identity.blockId, contentVersion: identity.contentVersion },
      ...(sourceId ? { problem: { sourceId, stemSnapshot: identity.prompt.slice(0, 2000), artifactKind: "reference_item" as const } } : {}),
    });
    assertInlinePreparedAttempt(captured, canonical);
    state.attempt = canonical; captured.attemptId = canonical.id; publish();
    return canonical;
  }
  let consumerPending: Promise<LearningAttempt> | null = null;
  return { prepare() {
    publish();
    state.pending ??= run().finally(() => { state.pending = null; });
    // A remounted form shares the HTTP request, but must receive the final keys
    // in its own checkpoint callback before it can submit or retry.
    consumerPending ??= state.pending.finally(() => { publish(); consumerPending = null; });
    return consumerPending;
  } };
}
