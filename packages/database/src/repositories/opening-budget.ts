import { randomUUID } from "node:crypto";
import { openingModelSnapshotSchema, type OpeningModelSnapshot } from "@aistudy/contracts";
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

export type BudgetReservationRecord = {
  id: string;
  workspaceId: string;
  purpose: string;
  amountCents: number;
  requestId: string;
  state: string;
  modelSnapshot: OpeningModelSnapshot | null;
};

export type ReserveInput = {
  modelSnapshot?: OpeningModelSnapshot;
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
   * Immediate markUnknown does not flip state; only aged reserved rows are
   * swept lazily inside the next reserve (see OPENING_BUDGET_UNKNOWN_RECONCILE_TTL_MS).
   */
  markUnknown(reservationId: string): Promise<BudgetReservationRecord>;
};

/**
 * Conservative TTL for lazy unknown/abandoned reservation reconcile (DL7).
 * Aged `reserved` rows older than this become `completed` at the reserved
 * amount (pessimistic bill) inside the next `reserve` transaction.
 * Default: 30 minutes (provider timeout Ã— max attempts ballpark).
 * Integration tests use ~35 min aged / ~5 min fresh against this constant.
 */
export const OPENING_BUDGET_UNKNOWN_RECONCILE_TTL_MS = 30 * 60 * 1000;

/** Local-day boundary for completed spend counting; matches remind worker default. */
export const OPENING_BUDGET_DEFAULT_TIME_ZONE = "Asia/Shanghai";

export type OpeningBudgetRepositoryOptions = {
  dailyCapCents: number;
  /** IANA timezone for local-day completed counting. Default Asia/Shanghai. */
  timeZone?: string;
  /**
   * Override reconcile TTL in milliseconds (tests only).
   * Production uses OPENING_BUDGET_UNKNOWN_RECONCILE_TTL_MS (~30 min).
   */
  unknownReconcileTtlMs?: number;
  /**
   * Per-reserve effective cap resolver (workspace prefs + env). When set,
   * used instead of the baked dailyCapCents for the spend check.
   */
  resolveDailyCapCents?: (scope: OpeningScope) => Promise<number>;
};

function mapReservation(row: Record<string, unknown>): BudgetReservationRecord {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    purpose: row.purpose as string,
    amountCents: Number(row.amount_cents),
    requestId: row.request_id as string,
    state: row.state as string,
    modelSnapshot: row.model_snapshot == null ? null : openingModelSnapshotSchema.parse(row.model_snapshot),
  };
}

export function createOpeningBudgetRepository(
  sql: Sql,
  options: OpeningBudgetRepositoryOptions = { dailyCapCents: 0 },
): OpeningBudgetRepository {
  if (!Number.isSafeInteger(options.dailyCapCents) || options.dailyCapCents < 0) throw new Error("invalid daily budget cap");
  const timeZone = options.timeZone ?? OPENING_BUDGET_DEFAULT_TIME_ZONE;
  const reconcileTtlMs = options.unknownReconcileTtlMs ?? OPENING_BUDGET_UNKNOWN_RECONCILE_TTL_MS;
  if (!Number.isSafeInteger(reconcileTtlMs) || reconcileTtlMs <= 0) throw new Error("invalid unknown reconcile TTL");

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
      WHERE ${predicate} AND state = 'reserved'
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
      if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
        throw new OpeningBudgetError("CONFLICT", "amount must be a positive integer");
      }
      const modelSnapshot = input.modelSnapshot ? openingModelSnapshotSchema.parse(input.modelSnapshot) : null;
      return sql.begin(async (tx) => {
        const owners = await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
        if (!owners.length) throw new OpeningBudgetError("NOT_FOUND", "workspace not found");
        const existing = await tx`SELECT * FROM opening_budget_reservations WHERE request_id=${input.requestId}`;
        if (existing.length) {
          const row = mapReservation(existing[0] as Record<string, unknown>);
          if (row.workspaceId !== scope.workspaceId || row.purpose !== input.purpose || row.amountCents !== input.amountCents || row.state !== 'reserved' || JSON.stringify(row.modelSnapshot) !== JSON.stringify(modelSnapshot)) {
            throw new OpeningBudgetError("CONFLICT", "request already consumed or changed");
          }
          return row;
        }

        const dailyCapCents = options.resolveDailyCapCents
          ? await options.resolveDailyCapCents(scope)
          : options.dailyCapCents;
        if (!Number.isSafeInteger(dailyCapCents) || dailyCapCents < 0) {
          throw new OpeningBudgetError("CONFLICT", "invalid daily budget cap");
        }

        // Lazy reconcile: aged reserved (incl. markUnknown retains) â†’ completed at reserved amount.
        // Pessimistic â€” never flip to released (under-billing risk). Fresh reserved untouched.
        await tx`
          UPDATE opening_budget_reservations
          SET state = 'completed', updated_at = now()
          WHERE workspace_id = ${scope.workspaceId}
            AND state = 'reserved'
            AND created_at < now() - (${reconcileTtlMs} * interval '1 millisecond')
        `;

        // Count remaining reserved + completed whose created_at falls on the user local day.
        // Drop updated_at so reconcile/settle mid-day cannot double-count across days.
        const rows = await tx`
          INSERT INTO opening_budget_reservations (id, workspace_id, purpose, amount_cents, request_id, model_snapshot)
          SELECT ${randomUUID()}, ${scope.workspaceId}, ${input.purpose}, ${input.amountCents}, ${input.requestId}, ${modelSnapshot === null ? null : tx.json(modelSnapshot)}
          WHERE ${input.amountCents} + COALESCE((
            SELECT sum(amount_cents) FROM opening_budget_reservations
            WHERE workspace_id=${scope.workspaceId} AND (state='reserved' OR
              (state='completed' AND (created_at AT TIME ZONE ${timeZone})::date
                = (now() AT TIME ZONE ${timeZone})::date))
          ), 0) <= ${dailyCapCents}
          RETURNING *
        `;
        if (!rows.length) throw new OpeningBudgetError("BUDGET_EXCEEDED", "daily workspace budget exceeded");
        return mapReservation(rows[0] as Record<string, unknown>);
      });
    },
    release(requestId) {
      return changeState({ by: "requestId", value: requestId }, "released");
    },
    complete(requestId) {
      return changeState({ by: "requestId", value: requestId }, "completed");
    },
    async settle(reservationId, actualCents) {
      if (!Number.isSafeInteger(actualCents) || actualCents <= 0) {
        throw new OpeningBudgetError("CONFLICT", "actual amount must be a positive integer");
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
      // cap ('reserved') until aged lazy reconcile completes it pessimistically.
      return byId(reservationId);
    },
  };
}

