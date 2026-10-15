import type { JobStatusResponse, TurnRecord, TutorMode } from "@aistudy/contracts";

/** UI pause only: this never settles usage or changes the original outcome. */
export const UNKNOWN_TURN_RETRY_DELAY_MS = 60_000;

export function unknownTurnRecovery(job: JobStatusResponse | null, now: number) {
  if (job?.status !== "outcome_unknown") return null;
  const readyAt = Date.parse(job.updatedAt) + UNKNOWN_TURN_RETRY_DELAY_MS;
  return { readyAt, canRetry: now >= readyAt };
}

/** Bind the intervening turn read to the same terminal job, without retry loops. */
export function sameUnknownJob(before: JobStatusResponse, after: JobStatusResponse | null): boolean {
  return before.status === "outcome_unknown" && after?.status === "outcome_unknown"
    && before.id === after.id && before.updatedAt === after.updatedAt;
}

/** Older jobs can be terminal while their assistant placeholder is still pending. */
export function turnsWithKnownOutcome(turns: readonly TurnRecord[], job: JobStatusResponse | null): readonly TurnRecord[] {
  const last = turns.at(-1);
  if (job?.status !== "outcome_unknown" || last?.role !== "assistant" || last.status !== "pending") return turns;
  return [...turns.slice(0, -1), { ...last, status: "outcome_unknown" }];
}

/** Only the latest unanswered pair can be offered again; never reuse an older question. */
export function unknownTurnQuestion(turns: readonly TurnRecord[]): { text: string; mode: TutorMode } | null {
  const assistant = turns.at(-1);
  const user = turns.at(-2);
  if (assistant?.role !== "assistant" || assistant.status !== "outcome_unknown" || user?.role !== "user") return null;
  return { text: user.text, mode: user.mode };
}
