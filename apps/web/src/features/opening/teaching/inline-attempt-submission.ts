import type { LearningObservation } from "@aistudy/contracts";
import { z } from "zod";
import type { createOpeningLearningClient } from "../client/learning-client";

const identitySchema = z.object({
  activityId: z.string().uuid(), courseId: z.string().uuid(), blockId: z.string().uuid(),
  contentVersion: z.number().int().positive(), sourceIds: z.array(z.string().uuid()).max(32),
  prompt: z.string().max(100_000), skillLabel: z.string().min(1).max(200), answer: z.string().max(20_000),
}).strict();

/** Only request identity is persisted. Browser data never proves that an answer was saved. */
export const inlineAttemptSubmissionCheckpointSchema = z.object({
  input: identitySchema,
  attemptKey: z.string().regex(/^teaching-attempt:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
  submitKey: z.string().regex(/^teaching-answer:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
  sessionId: z.string().uuid().nullable(), attemptId: z.string().uuid().nullable(),
  status: z.enum(["pending", "saved"]),
}).strict().refine(value => (!value.attemptId || Boolean(value.sessionId)) && (value.status !== "saved" || Boolean(value.attemptId)));

export type InlineAttemptIdentity = z.infer<typeof identitySchema>;
export type InlineAttemptSubmissionCheckpoint = z.infer<typeof inlineAttemptSubmissionCheckpointSchema>;
type LearningClient = ReturnType<typeof createOpeningLearningClient>;
type SubmissionResult = { attemptId: string; observation: LearningObservation };
type SubmissionState = { checkpoint: InlineAttemptSubmissionCheckpoint; result: SubmissionResult | null; pending: Promise<SubmissionResult> | null };
// A route change can unmount the form while its HTTP request is still running.
// Returning in the same document shares that request instead of starting a second session.
const submissions = new Map<string, SubmissionState>();

/** Idempotent submit replays return the original row; resume from the server's effective head. */
export async function readInlineAttemptObservationHead(observationId: string, client: Pick<LearningClient, "getObservationHistory">): Promise<LearningObservation | null> {
  const history = await client.getObservationHistory(observationId);
  const head = history.revisions.find(row => row.id === history.headObservationId);
  return head && head.revisionKind !== "retract" ? head : null;
}

/** Capture one answer and identity; retries, including after a remount, reuse its write keys. */
export function createInlineAttemptSubmission(
  input: InlineAttemptIdentity,
  client: Pick<LearningClient, "createSession" | "createAttempt" | "submitAttempt">,
  options: { checkpoint?: InlineAttemptSubmissionCheckpoint; onCheckpoint?: (checkpoint: InlineAttemptSubmissionCheckpoint) => void } = {},
) {
  const checkpoint = options.checkpoint ?? {
    input: { ...input, sourceIds: [...input.sourceIds] },
    attemptKey: `teaching-attempt:${crypto.randomUUID()}`, submitKey: `teaching-answer:${crypto.randomUUID()}`,
    sessionId: null, attemptId: null, status: "pending" as const,
  };
  const cached = submissions.get(checkpoint.attemptKey);
  const sameInput = (value: InlineAttemptIdentity) => JSON.stringify([value.activityId, value.courseId, value.blockId, value.contentVersion, value.sourceIds, value.prompt, value.skillLabel, value.answer]);
  const state = cached && cached.checkpoint.submitKey === checkpoint.submitKey && sameInput(cached.checkpoint.input) === sameInput(checkpoint.input)
    ? cached : { checkpoint, result: null, pending: null };
  if (!cached) submissions.set(checkpoint.attemptKey, state);
  const publish = () => options.onCheckpoint?.({ ...state.checkpoint, input: { ...state.checkpoint.input, sourceIds: [...state.checkpoint.input.sourceIds] } });
  async function run() {
    if (state.result) return state.result;
    const captured = state.checkpoint;
    const answer = captured.input;
    if (!captured.sessionId) {
      captured.sessionId = (await client.createSession({ courseId: answer.courseId, activityId: answer.activityId, skillLabel: answer.skillLabel, sourceIds: answer.sourceIds })).id;
      publish();
    }
    if (!captured.attemptId) {
      const sourceId = answer.sourceIds[0];
      captured.attemptId = (await client.createAttempt({ sessionId: captured.sessionId, clientKey: captured.attemptKey, teachingBlock: { blockId: answer.blockId, contentVersion: answer.contentVersion },
        ...(sourceId ? { problem: { sourceId, stemSnapshot: answer.prompt.slice(0, 2000), artifactKind: "reference_item" as const } } : {}),
      })).id;
      publish();
    }
    const observation = await client.submitAttempt(captured.attemptId, { clientKey: captured.submitKey, answer: answer.answer, outcome: "unverified", assistance: "independent", verdictSource: "self_report" });
    captured.status = "saved";
    state.result = { attemptId: captured.attemptId, observation };
    publish();
    return state.result;
  }
  return {
    submit() {
      // Save the immutable answer and both keys before the first outgoing write.
      publish();
      state.pending ??= run().finally(() => { state.pending = null; });
      return state.pending;
    },
  };
}
