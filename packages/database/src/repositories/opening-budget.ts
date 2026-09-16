import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import type { OpeningScope } from "./opening-sources";

export type OpeningBudgetErrorCode = "CONFLICT" | "NOT_FOUND" | "BUDGET_EXCEEDED";

export class OpeningBudgetError extends Error {
  readonly code: OpeningBudgetErrorCode;

  constructor(code: OpeningBudgetErrorCode, message: string) {
    super(message);
    this.name = "OpeningBudgetError";
    this.code = code;
  }
}

/** Hard per-workspace spend ceiling (cents) until a configured budget lands. */
const WORKSPACE_CAP_CENTS = 100_000;

export type BudgetReservationRecord = {
  id: string;
  workspaceId: string;
  purpose: string;
  amountCents: number;
  requestId: string;
  state: string;
};

export type ReserveInput = {
  purpose: string;
  amountCents: number;
  requestId: string;
};

export type OpeningBudgetRepository = {
  /**
   * Atomically reserve spend against the workspace cap; idempotent by
   * requestId (replays the original reservation). Overspend rejects with
   * BUDGET_EXCEEDED and writes nothing.
   */
  reserve(scope: OpeningScope, input: ReserveInput): Promise<BudgetReservationRecord>;
  release(requestId: string): Promise<BudgetReservationRecord>;
  complete(requestId: string): Promise<BudgetReservationRecord>;
  /** Ledger flow: reconcile a completed call to its actual cost. */
  settle(reservationId: string, actualCents: number): Promise<BudgetReservationRecord>;
  /**
   * Unknown remote outcome: the reservation RETAINS its cap space (stays
   * 'reserved'; the 0018 CHECK has no 'unknown' state) until reconciliation.
   */
  markUnknown(reservationId: string): Promise<BudgetReservationRecord>;
};

function mapReservation(row: Record<string, unknown>): BudgetReservationRecord {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    purpose: row.purpose as string,
    amountCents: Number(row.amount_cents),
    requestId: row.request_id as string,
    state: row.state as string,
  };
}

export function createOpeningBudgetRepository(sql: Sql): OpeningBudgetRepository {
  const changeState = async (
    where: { by: "requestId" | "id"; value: string },
    state: "released" | "completed",
  ) => {
    const predicate = where.by === "requestId"
      ? sql`request_id = ${where.value}`
      : sql`id = ${where.value}`;
    const rows = await sql`
      UPDATE opening_budget_reservations
      SET state = ${state}, updated_at = now()
      WHERE ${predicate}
      RETURNING *
    `;
    if (!rows.length) {
      throw new OpeningBudgetError("NOT_FOUND", "reservation not found");
    }
    return mapReservation(rows[0] as Record<string, unknown>);
  };
  const byId = async (reservationId: string): Promise<BudgetReservationRecord> => {
    const rows = await sql`
      SELECT * FROM opening_budget_reservations WHERE id = ${reservationId}
    `;
    if (!rows.length) {
      throw new OpeningBudgetError("NOT_FOUND", "reservation not found");
    }
    return mapReservation(rows[0] as Record<string, unknown>);
  };

  return {
    async reserve(scope, input) {
      if (input.amountCents <= 0) {
        throw new OpeningBudgetError("CONFLICT", "amount must be positive");
      }
      const rows = await sql`
        INSERT INTO opening_budget_reservations (id, workspace_id, purpose, amount_cents, request_id)
        SELECT ${randomUUID()}, ${scope.workspaceId}, ${input.purpose}, ${input.amountCents}, ${input.requestId}
        WHERE ${input.amountCents} + COALESCE((
          SELECT sum(amount_cents) FROM opening_budget_reservations
          WHERE workspace_id = ${scope.workspaceId} AND state = 'reserved'
        ), 0) <= ${WORKSPACE_CAP_CENTS}
        ON CONFLICT (request_id) DO NOTHING
        RETURNING *
      `;
      if (rows.length) {
        return mapReservation(rows[0] as Record<string, unknown>);
      }
      const existing = await sql`
        SELECT * FROM opening_budget_reservations WHERE request_id = ${input.requestId}
      `;
      if (existing.length) {
        return mapReservation(existing[0] as Record<string, unknown>);
      }
      throw new OpeningBudgetError("BUDGET_EXCEEDED", "workspace budget exceeded");
    },
    release(requestId) {
      return changeState({ by: "requestId", value: requestId }, "released");
    },
    complete(requestId) {
      return changeState({ by: "requestId", value: requestId }, "completed");
    },
    async settle(reservationId, actualCents) {
      if (actualCents < 0) {
        throw new OpeningBudgetError("CONFLICT", "actual amount must not be negative");
      }
      const rows = await sql`
        UPDATE opening_budget_reservations
        SET amount_cents = ${actualCents}, state = 'completed', updated_at = now()
        WHERE id = ${reservationId} AND state = 'reserved'
        RETURNING *
      `;
      if (!rows.length) {
        throw new OpeningBudgetError("NOT_FOUND", "reservation not found or already settled");
      }
      return mapReservation(rows[0] as Record<string, unknown>);
    },
    async markUnknown(reservationId) {
      // Outcome unknown: keep the reservation counted against the workspace
      // cap ('reserved') until reconciliation settles or releases it.
      return byId(reservationId);
    },
  };
}
