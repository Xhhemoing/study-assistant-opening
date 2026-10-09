import { randomUUID } from "node:crypto";
import { openingModelSnapshotSchema, type OpeningModelSnapshot } from "@aistudy/contracts";
import {
  OPENING_PERSONAL_DAILY_CAP_CEILING_CENTS,
  resolveEffectiveDailyCap,
} from "@aistudy/ai";
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
   * 'reserved') until lazy reconciliation settles it as completed.
   */
  markUnknown(reservationId: string): Promise<BudgetReservationRecord>;
};

export type OpeningBudgetRepositoryOptions = {
  /** Deployment env daily cap (OPENING_MODEL_DAILY_CAP_CENTS). */
  envCapCents: number;
  /** True when the default/catalog model has positive pricing configured. */
  pricingConfigured?: boolean;
  ceilingCents?: number;
  /** IANA timezone for the local budget day (default Asia/Shanghai). */
  timeZone?: string;
  /** Age after which reserved rows are pessimistically completed (default 30 min). */
  unknownAgeMs?: number;
};

const DEFAULT_UNKNOWN_AGE_MS = 30 * 60 * 1000;

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

function readWorkspaceBudget(aiSettings: unknown): {
  workspaceCapCents: number | null;
  confirmed: boolean;
} {
  if (aiSettings == null || typeof aiSettings !== "object" || Array.isArray(aiSettings)) {
    return { workspaceCapCents: null, confirmed: false };
  }
  const raw = aiSettings as Record<string, unknown>;
  const cap = raw.dailyCapCents;
  const workspaceCapCents =
    typeof cap === "number" && Number.isSafeInteger(cap) && cap >= 0 ? cap : null;
  const confirmedAt = raw.budgetConfirmedAt;
  const confirmed = typeof confirmedAt === "string" && confirmedAt.length > 0;
  return { workspaceCapCents, confirmed };
}

export function createOpeningBudgetRepository(
  sql: Sql,
  options: OpeningBudgetRepositoryOptions = { envCapCents: 0 },
): OpeningBudgetRepository {
  if (!Number.isSafeInteger(options.envCapCents) || options.envCapCents < 0) {
    throw new Error("invalid daily budget cap");
  }
  const timeZone = options.timeZone ?? "Asia/Shanghai";
  const unknownAgeMs = options.unknownAgeMs ?? DEFAULT_UNKNOWN_AGE_MS;
  if (!Number.isSafeInteger(unknownAgeMs) || unknownAgeMs <= 0) {
    throw new Error("invalid unknown reservation age");
  }
  const ceilingCents = options.ceilingCents ?? OPENING_PERSONAL_DAILY_CAP_CEILING_CENTS;
  const pricingConfigured = options.pricingConfigured ?? true;

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

        // Lazy reconcile: stale reserved rows become completed (pessimistic billing).
        const cutoff = new Date(Date.now() - unknownAgeMs);
        await tx`
          UPDATE opening_budget_reservations
          SET state = 'completed', updated_at = now()
          WHERE workspace_id = ${scope.workspaceId}
            AND state = 'reserved'
            AND created_at < ${cutoff}
        `;

        const prefs = await tx`
          SELECT ai_settings FROM workspace_preferences WHERE workspace_id = ${scope.workspaceId}
        `;
        const { workspaceCapCents, confirmed } = readWorkspaceBudget(prefs[0]?.ai_settings ?? null);
        const effective = resolveEffectiveDailyCap({
          envCapCents: options.envCapCents,
          workspaceCapCents,
          confirmed,
          pricingConfigured,
          ceilingCents,
        });

        const existing = await tx`SELECT * FROM opening_budget_reservations WHERE request_id=${input.requestId}`;
        if (existing.length) {
          const row = mapReservation(existing[0] as Record<string, unknown>);
          if (row.workspaceId !== scope.workspaceId || row.purpose !== input.purpose || row.amountCents !== input.amountCents || row.state !== 'reserved' || JSON.stringify(row.modelSnapshot) !== JSON.stringify(modelSnapshot)) {
            throw new OpeningBudgetError("CONFLICT", "request already consumed or changed");
          }
          return row;
        }

        // Count all current reserved rows plus completed spend created on the local day.
        const rows = await tx`
          INSERT INTO opening_budget_reservations (id, workspace_id, purpose, amount_cents, request_id, model_snapshot)
          SELECT ${randomUUID()}, ${scope.workspaceId}, ${input.purpose}, ${input.amountCents}, ${input.requestId}, ${modelSnapshot === null ? null : tx.json(modelSnapshot)}
          WHERE ${input.amountCents} + COALESCE((
            SELECT sum(amount_cents) FROM opening_budget_reservations
            WHERE workspace_id=${scope.workspaceId} AND (
              state='reserved' OR
              (state='completed' AND (created_at AT TIME ZONE ${timeZone})::date
                = (now() AT TIME ZONE ${timeZone})::date)
            )
          ), 0) <= ${effective.capCents}
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
      // cap ('reserved') until lazy reconciliation completes it.
      return byId(reservationId);
    },
  };
}
