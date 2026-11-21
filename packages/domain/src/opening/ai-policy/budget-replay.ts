/** Minimal reservation view; extra fields come from the real ledger. */
export type BudgetedReservation = {
  id: string;
  requestId?: string;
  state?: string;
  replayed?: boolean;
  outcomeUnknownAt?: Date | null;
  releaseReason?: string | null;
  resultRef?: string | null;
  reconciledAt?: Date | null;
  pendingReconcileCents?: number;
};

export type BudgetReplayDisposition =
  | { kind: "completed"; reservationId: string; resultRef: string | null }
  | { kind: "released"; reservationId: string; reason: string | null }
  | { kind: "unknown"; reservationId: string; pendingReconcileCents: number; reconciled: boolean }
  | { kind: "in_flight"; reservationId: string };

/**
 * Decide from a reserve() result whether this caller may proceed. Returns
 * null for a fresh/claimable reserved row. Never fabricates success.
 */
export function replayDisposition(reservation: BudgetedReservation): BudgetReplayDisposition | null {
  const id = reservation.id;
  if (reservation.state === undefined || reservation.state === "reserved") {
    if (reservation.outcomeUnknownAt) {
      return { kind: "unknown", reservationId: id, pendingReconcileCents: 0, reconciled: false };
    }
    return null;
  }
  if (reservation.state === "released") {
    return { kind: "released", reservationId: id, reason: reservation.releaseReason ?? null };
  }
  if (reservation.reconciledAt && (reservation.pendingReconcileCents ?? 0) > 0) {
    return { kind: "unknown", reservationId: id, pendingReconcileCents: reservation.pendingReconcileCents ?? 0, reconciled: true };
  }
  return { kind: "completed", reservationId: id, resultRef: reservation.resultRef ?? null };
}

const REPLAY_CODES = {
  completed: "BUDGET_REPLAY_COMPLETED",
  released: "BUDGET_REPLAY_RELEASED",
  unknown: "BUDGET_OUTCOME_UNKNOWN",
  in_flight: "BUDGET_EXECUTION_CLAIMED",
} as const;

export type BudgetCallOutcomeCode = (typeof REPLAY_CODES)[keyof typeof REPLAY_CODES];

/** Replay of an existing ledger key: no provider call, no extra charge. */
export class BudgetReplayError extends Error {
  readonly code: BudgetCallOutcomeCode;
  readonly disposition: BudgetReplayDisposition;

  constructor(disposition: BudgetReplayDisposition) {
    super(`budget replay: ${disposition.kind}`);
    this.name = "BudgetReplayError";
    this.code = REPLAY_CODES[disposition.kind];
    this.disposition = disposition;
  }
}

export function isBudgetReplayError(error: unknown): error is BudgetReplayError {
  return error instanceof BudgetReplayError;
}
