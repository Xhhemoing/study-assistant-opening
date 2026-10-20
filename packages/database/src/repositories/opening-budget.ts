import { resolveWorkspaceTimeZone } from "@aistudy/domain";
import { randomUUID } from "node:crypto";
import { openingModelSnapshotSchema, type OpeningModelSnapshot } from "@aistudy/contracts";
import {
  OPENING_PERSONAL_DAILY_CAP_CEILING_CENTS,
  DEFAULT_PARENT_INTERACTION_MAX_PROVIDER_CALLS,
  assertParentInteractionBudget,
  type ParentInteractionBudget,
  resolveBudgetLocalDay,
  resolveBudgetTimeZone,
  resolveEffectiveDailyCap,
} from "@aistudy/ai";
import type { Sql } from "postgres";
import type { OpeningScope } from "./opening-sources";

export type OpeningBudgetErrorCode = "CONFLICT" | "NOT_FOUND" | "BUDGET_EXCEEDED" | "BUDGET_INVALID_RESERVE" | "REQUEST_CAP_EXCEEDED" | "PARENT_BUDGET_EXCEEDED" | "PARENT_BUDGET_CALL_LIMIT" | "PARENT_BUDGET_OUTCOME_UNKNOWN" | "PARENT_BUDGET_BLOCKED";

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
  parentInteractionId: string | null;
  settlementCostBasis: "usage_pricing" | "media_usage_upper_bound" | "vendor_receipt" | null;
  purpose: string;
  amountCents: number;
  requestId: string;
  state: string;
  modelSnapshot: OpeningModelSnapshot | null;
  /** Set once a single caller atomically won the right to call the provider. */
  executionClaimedAt: Date | null;
  /** Post-send outcome/cost unknown (row still holds its cap as 'reserved'). */
  outcomeUnknownAt: Date | null;
  /** Explicit not-sent failure / cancel reason for 'released' rows. */
  releaseReason: string | null;
  /** Caller-persisted result reference for a completed call (replayed, never re-run). */
  resultRef: string | null;
  /** TTL reconcile time; with pendingReconcileCents>0 the charge is provisional. */
  reconciledAt: Date | null;
  pendingReconcileCents: number;
  /** Original reserve amount (null on pre-0059 rows). */
  reservedAmountCents: number | null;
  /** True when reserve() returned an existing row for the same request key. */
  replayed: boolean;
};

export type ReleaseReason = "not_sent" | "cancelled";

export type BudgetReconcileEventKind = "ttl_reconciled" | "late_receipt" | "cap_overrun";

export type BudgetReconcileEvent = {
  id: string;
  reservationId: string;
  workspaceId: string;
  kind: BudgetReconcileEventKind;
  amountBeforeCents: number;
  amountAfterCents: number;
  reportedActualCents: number | null;
  stateBefore: string;
  capCents: number | null;
  usageAfterCents: number | null;
  createdAt: Date;
};

function mapEvent(row: Record<string, unknown>): BudgetReconcileEvent {
  const num = (v: unknown) => (v == null ? null : Number(v));
  return {
    id: row.id as string,
    reservationId: row.reservation_id as string,
    workspaceId: row.workspace_id as string,
    kind: row.kind as BudgetReconcileEventKind,
    amountBeforeCents: Number(row.amount_before_cents),
    amountAfterCents: Number(row.amount_after_cents),
    reportedActualCents: num(row.reported_actual_cents),
    stateBefore: row.state_before as string,
    capCents: num(row.cap_cents),
    usageAfterCents: num(row.usage_after_cents),
    createdAt: toDate(row.created_at) as Date,
  };
}

export type ReserveInput = {
  parentBudget?: ParentInteractionBudget;
  modelSnapshot?: OpeningModelSnapshot;
  purpose: string;
  amountCents: number;
  requestId: string;
  /**
   * Free-tier models: at most this many non-released reservations for the snapshot's
   * model on the local budget day. Required for (and only meaningful with) amountCents 0.
   */
  requestCapPerDay?: number;
};

export type OpeningBudgetRepository = {
  /**
   * Atomically reserve spend against the workspace cap; idempotent by
   * requestId (replays the original reservation). Overspend rejects with
   * BUDGET_EXCEEDED and writes nothing.
   */
  reserve(scope: OpeningScope, input: ReserveInput): Promise<BudgetReservationRecord>;
  /** Scope-bound: only rows of scope.workspaceId owned by scope.ownerUserId. */
  release(scope: OpeningScope, requestId: string, reason?: ReleaseReason): Promise<BudgetReservationRecord>;
  complete(scope: OpeningScope, requestId: string, options?: { resultRef?: string }): Promise<BudgetReservationRecord>;
  /**
   * Atomically claim the single right to call the provider for a reserved,
   * not-yet-claimed, not-unknown reservation. Exactly one concurrent caller
   * gets true.
   */
  claimExecution(scope: OpeningScope, reservationId: string): Promise<boolean>;
  /**
   * Ledger flow: reconcile a completed call to its actual cost (scope-bound).
   * A late receipt for a TTL-reconciled (or released) row is applied through an
   * audited reconcile event instead of being dropped; duplicates are NOT_FOUND.
   */
  settle(
    scope: OpeningScope,
    reservationId: string,
    actualCents: number,
    options?: { resultRef?: string; costBasis?: "usage_pricing" | "media_usage_upper_bound" | "vendor_receipt" },
  ): Promise<BudgetReservationRecord>;
  /**
   * Unknown remote outcome: the reservation RETAINS its cap space (stays
   * 'reserved', outcome_unknown_at set) until lazy reconciliation completes it
   * at full amount with an observable pending-reconcile record.
   */
  markUnknown(scope: OpeningScope, reservationId: string): Promise<BudgetReservationRecord>;
  /** Audit trail (scope-bound), oldest first; optionally filtered by kind. */
  listReconcileEvents(scope: OpeningScope, filter?: { kind?: BudgetReconcileEventKind }): Promise<BudgetReconcileEvent[]>;
  /** Rows still charged provisionally (TTL-reconciled, receipt not yet seen). */
  listPendingReconcile(scope: OpeningScope): Promise<BudgetReservationRecord[]>;
};

export type OpeningBudgetRepositoryOptions = {
  /** Deployment env daily cap (OPENING_MODEL_DAILY_CAP_CENTS). */
  envCapCents: number;
  /** True when the default/catalog model has positive pricing configured. */
  pricingConfigured?: boolean;
  ceilingCents?: number;
  /**
   * Fallback IANA timezone when workspace planning_settings.timeZone is absent
   * (default Asia/Shanghai / DL7). Prefer per-workspace planning TZ at reserve.
   */
  timeZone?: string;
  /** Age after which reserved rows are pessimistically completed (default 30 min). */
  unknownAgeMs?: number;
  /**
   * Alert hook for reconcile anomalies (e.g. a late receipt pushing usage over
   * the cap). Called after the audit event is committed; never replaces it.
   */
  onReconcileAlert?: (event: BudgetReconcileEvent) => void | Promise<void>;
};

function isRequestIdUniqueViolation(error: unknown): boolean {
  if (error == null || typeof error !== "object") return false;
  const e = error as { code?: unknown; constraint_name?: unknown; table_name?: unknown };
  return e.code === "23505"
    && (e.constraint_name === "opening_budget_reservations_request_id_key"
      || (e.constraint_name == null && e.table_name === "opening_budget_reservations"));
}

/**
 * Conservative TTL for lazy unknown/abandoned reservation reconcile (DL7).
 * Aged reserved rows older than this become completed at the reserved amount
 * (pessimistic) inside the next reserve transaction. Default: 30 minutes.
 */
export const OPENING_BUDGET_UNKNOWN_RECONCILE_TTL_MS = 30 * 60 * 1000;

function toDate(value: unknown): Date | null {
  if (value == null) return null;
  return value instanceof Date ? value : new Date(String(value));
}

function mapReservation(row: Record<string, unknown>, replayed = false): BudgetReservationRecord {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    parentInteractionId: (row.parent_interaction_id as string | null) ?? null,
    settlementCostBasis: (row.settlement_cost_basis as BudgetReservationRecord["settlementCostBasis"]) ?? null,
    purpose: row.purpose as string,
    amountCents: Number(row.amount_cents),
    requestId: row.request_id as string,
    state: row.state as string,
    modelSnapshot: row.model_snapshot == null ? null : openingModelSnapshotSchema.parse(row.model_snapshot),
    executionClaimedAt: toDate(row.execution_claimed_at),
    outcomeUnknownAt: toDate(row.outcome_unknown_at),
    releaseReason: (row.release_reason as string | null | undefined) ?? null,
    resultRef: (row.result_ref as string | null | undefined) ?? null,
    reconciledAt: toDate(row.reconciled_at),
    pendingReconcileCents: Number(row.pending_reconcile_cents ?? 0),
    reservedAmountCents: row.reserved_amount_cents == null ? null : Number(row.reserved_amount_cents),
    replayed,
  };
}


function readPlanningTimeZone(planningSettings: unknown): string | null {
  if (planningSettings == null || typeof planningSettings !== "object" || Array.isArray(planningSettings)) {
    return null;
  }
  const tz = (planningSettings as Record<string, unknown>).timeZone;
  // PR-B: a stored-but-invalid zone fails loudly (RangeError "invalid timeZone: X"),
  // consistent with remind / reminders / review queue; never a silent default.
  return typeof tz === "string" && tz.trim().length > 0 ? resolveWorkspaceTimeZone(tz) : null;
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
  const fallbackTimeZone = resolveBudgetTimeZone(options.timeZone);
  const onReconcileAlert = options.onReconcileAlert;
  const unknownAgeMs = options.unknownAgeMs ?? OPENING_BUDGET_UNKNOWN_RECONCILE_TTL_MS;
  if (!Number.isSafeInteger(unknownAgeMs) || unknownAgeMs <= 0) {
    throw new Error("invalid unknown reservation age");
  }
  const ceilingCents = options.ceilingCents ?? OPENING_PERSONAL_DAILY_CAP_CEILING_CENTS;
  const pricingConfigured = options.pricingConfigured ?? true;

  // Least privilege: every post-reserve mutation/read is bound to the caller's
  // owned workspace. A foreign or unowned row is indistinguishable from absent.
  const inScope = (scope: OpeningScope) => sql`
    workspace_id = ${scope.workspaceId}
    AND EXISTS (SELECT 1 FROM workspaces w WHERE w.id = ${scope.workspaceId} AND w.owner_user_id = ${scope.ownerUserId})
  `;
  const changeState = async (
    scope: OpeningScope,
    where: { by: "requestId" | "id"; value: string },
    state: "released" | "completed",
    extra: { releaseReason?: ReleaseReason; resultRef?: string } = {},
  ) => {
    const predicate = where.by === "requestId"
      ? sql`request_id = ${where.value}`
      : sql`id = ${where.value}`;
    // A post-send unknown outcome can never be released back to zero.
    const releasable = state === "released" ? sql`AND outcome_unknown_at IS NULL` : sql``;
    const rows = await sql`
      UPDATE opening_budget_reservations
      SET state = ${state}, updated_at = now(),
          release_reason = ${state === "released" ? extra.releaseReason ?? "not_sent" : null},
          result_ref = COALESCE(${extra.resultRef ?? null}, result_ref)
      WHERE ${predicate} AND ${inScope(scope)} AND state = 'reserved' ${releasable}
      RETURNING *
    `;
    if (!rows.length) {
      throw new OpeningBudgetError("NOT_FOUND", "reservation not found");
    }
    return mapReservation(rows[0] as Record<string, unknown>);
  };
  // Effective cap + local budget day for a workspace (same rules as reserve).
  const capAndDay = async (tx: Sql, workspaceId: string) => {
    const prefs = await tx`
      SELECT ai_settings, planning_settings FROM workspace_preferences WHERE workspace_id = ${workspaceId}
    `;
    const { workspaceCapCents, confirmed } = readWorkspaceBudget(prefs[0]?.ai_settings ?? null);
    const effective = resolveEffectiveDailyCap({
      envCapCents: options.envCapCents,
      workspaceCapCents,
      confirmed,
      pricingConfigured,
      ceilingCents,
    });
    // TZ01: local budget day; prefer workspace planning_settings.timeZone.
    const planningTz = readPlanningTimeZone(prefs[0]?.planning_settings ?? null);
    const budgetDay = resolveBudgetLocalDay(new Date(), resolveBudgetTimeZone(planningTz ?? fallbackTimeZone));
    return { capCents: effective.capCents, budgetDay };
  };
  const byId = async (scope: OpeningScope, reservationId: string): Promise<BudgetReservationRecord> => {
    const rows = await sql`
      SELECT * FROM opening_budget_reservations WHERE id = ${reservationId} AND ${inScope(scope)}
    `;
    if (!rows.length) {
      throw new OpeningBudgetError("NOT_FOUND", "reservation not found");
    }
    return mapReservation(rows[0] as Record<string, unknown>);
  };

  return {
    async reserve(scope, input) {
      if (input.parentBudget) {
        try { assertParentInteractionBudget(input.parentBudget); }
        catch { throw new OpeningBudgetError("BUDGET_INVALID_RESERVE", "invalid parent interaction budget"); }
      }
      const requestCap = input.requestCapPerDay;
      const zeroCost = input.amountCents === 0;
      if (!Number.isSafeInteger(input.amountCents) || input.amountCents < 0) {
        throw new OpeningBudgetError("BUDGET_INVALID_RESERVE", "amount must be a positive integer");
      }
      if (requestCap !== undefined && (!Number.isSafeInteger(requestCap) || requestCap <= 0)) {
        throw new OpeningBudgetError("BUDGET_INVALID_RESERVE", "request cap must be a positive integer");
      }
      const modelSnapshot = input.modelSnapshot ? openingModelSnapshotSchema.parse(input.modelSnapshot) : null;
      // A zero-cost call is only legitimate for a free-tier model with a request cap.
      if (zeroCost && (requestCap === undefined || modelSnapshot === null)) {
        throw new OpeningBudgetError("BUDGET_INVALID_RESERVE", "zero-cost reservation requires a model and a request cap");
      }
      try {
      return await sql.begin(async (tx) => {
        const owners = await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
        if (!owners.length) throw new OpeningBudgetError("NOT_FOUND", "workspace not found");

        // Lazy reconcile: stale reserved rows become completed (pessimistic billing).
        const cutoff = new Date(Date.now() - unknownAgeMs);
        // Full amount stays charged, but the row is observably provisional
        // (reconciled_at + pending_reconcile_cents) with an audit event; it is
        // never released at zero and never re-sent.
        await tx`
          WITH reconciled AS (
            UPDATE opening_budget_reservations
            SET state = 'completed', updated_at = now(), reconciled_at = now(),
                outcome_unknown_at = COALESCE(outcome_unknown_at, now()),
                pending_reconcile_cents = amount_cents
            WHERE workspace_id = ${scope.workspaceId}
              AND state = 'reserved'
              AND created_at < ${cutoff}
            RETURNING id, workspace_id, amount_cents
          )
          INSERT INTO opening_budget_reconcile_events
            (reservation_id, workspace_id, kind, amount_before_cents, amount_after_cents, state_before)
          SELECT id, workspace_id, 'ttl_reconciled', amount_cents, amount_cents, 'reserved' FROM reconciled
          ON CONFLICT (reservation_id, kind) DO NOTHING
        `;

        const { capCents, budgetDay } = await capAndDay(tx as unknown as Sql, scope.workspaceId);

        const existing = await tx`SELECT * FROM opening_budget_reservations WHERE request_id=${input.requestId}`;
        const existingRow = existing[0] ? mapReservation(existing[0] as Record<string, unknown>) : null;
        if (existingRow) {
          // Original amounts survive settlement. An old, unparented reservation
          // may be adopted once below; an attributed request can never move parents.
          const originalAmount = existingRow.reservedAmountCents ?? (existingRow.state === "reserved" ? existingRow.amountCents : null);
          if (existingRow.workspaceId !== scope.workspaceId || existingRow.purpose !== input.purpose
            || (existingRow.parentInteractionId !== null && existingRow.parentInteractionId !== (input.parentBudget?.id ?? null))
            || (originalAmount !== null && originalAmount !== input.amountCents)
            || JSON.stringify(existingRow.modelSnapshot) !== JSON.stringify(modelSnapshot)) {
            throw new OpeningBudgetError("CONFLICT", "request already consumed or changed");
          }
        }
        // An existing attributed key always replays, including a frozen/unknown
        // parent: replay never authorizes a second provider request.
        if (existingRow && (!input.parentBudget || existingRow.parentInteractionId !== null)) {
          return mapReservation(existing[0] as Record<string, unknown>, true);
        }

        if (input.parentBudget) {
          const parent = input.parentBudget;
          await tx`
            INSERT INTO opening_parent_interaction_budgets (workspace_id, id, budget_cents, max_provider_calls)
            VALUES (${scope.workspaceId}, ${parent.id}, ${Math.min(parent.budgetCents ?? capCents, capCents)},
              ${parent.maxProviderCalls ?? DEFAULT_PARENT_INTERACTION_MAX_PROVIDER_CALLS})
            ON CONFLICT (workspace_id, id) DO NOTHING
          `;
          const [pinned] = await tx`SELECT * FROM opening_parent_interaction_budgets
            WHERE workspace_id = ${scope.workspaceId} AND id = ${parent.id}`;
          // Retries may omit a tighter limit but cannot silently enlarge or replace it.
          if ((parent.budgetCents !== undefined && Math.min(parent.budgetCents, capCents) !== Number(pinned!.budget_cents))
            || (parent.maxProviderCalls !== undefined && parent.maxProviderCalls !== Number(pinned!.max_provider_calls))) {
            throw new OpeningBudgetError("CONFLICT", "parent interaction limits already pinned");
          }
          const [usage] = await tx`
            SELECT COALESCE(sum(amount_cents) FILTER (WHERE state <> 'released'), 0) AS cents,
              count(*)::int AS calls,
              count(*) FILTER (WHERE outcome_unknown_at IS NOT NULL)::int AS unknown_calls
            FROM opening_budget_reservations
            WHERE workspace_id = ${scope.workspaceId} AND parent_interaction_id = ${parent.id}
          `;
          // Existing post-send/terminal legacy rows must stay replayable and must
          // enter this parent's accounting, even when their bill already exceeds it.
          const replayOnly = existingRow && (existingRow.state !== "reserved" || existingRow.executionClaimedAt !== null || existingRow.outcomeUnknownAt !== null);
          if (!replayOnly) {
            if (pinned!.blocked_at) throw new OpeningBudgetError("PARENT_BUDGET_BLOCKED", "parent interaction cost bound was exceeded");
            if (Number(usage!.unknown_calls) > 0) throw new OpeningBudgetError("PARENT_BUDGET_OUTCOME_UNKNOWN", "parent interaction has unknown billing; not re-sending");
            if (Number(usage!.calls) >= Number(pinned!.max_provider_calls)) throw new OpeningBudgetError("PARENT_BUDGET_CALL_LIMIT", "parent interaction request limit reached");
            // All settled spend + outstanding reservations + next conservative bound.
            if (Number(usage!.cents) + input.amountCents > Number(pinned!.budget_cents)) {
              throw new OpeningBudgetError("PARENT_BUDGET_EXCEEDED", "parent interaction budget exceeded");
            }
          }
          if (existingRow) {
            const adopted = await tx`UPDATE opening_budget_reservations SET parent_interaction_id=${parent.id}
              WHERE id=${existingRow.id} AND workspace_id=${scope.workspaceId} RETURNING *`;
            return mapReservation(adopted[0] as Record<string, unknown>, true);
          }
        }

        if (requestCap !== undefined && modelSnapshot) {
          const [used] = await tx`
            SELECT count(*)::int AS n FROM opening_budget_reservations
            WHERE workspace_id=${scope.workspaceId} AND state <> 'released'
              AND model_snapshot->>'id' = ${modelSnapshot.id}
              AND created_at >= ${budgetDay.dayStart} AND created_at < ${budgetDay.nextDayStart}
          `;
          if (Number(used?.n ?? 0) >= requestCap) {
            throw new OpeningBudgetError("REQUEST_CAP_EXCEEDED", "该模型今天的请求次数已达上限；可在设置中为该用途指定备用模型。");
          }
        }

        // Count all current reserved rows plus completed spend on the local day
        // using half-open [dayStart, nextDayStart) absolute instants (not UTC date).
        // A zero-cost (free-tier) row adds no spend, so the cents cap does not gate it.
        const rows = await tx`
          INSERT INTO opening_budget_reservations (id, workspace_id, purpose, amount_cents, reserved_amount_cents, request_id, model_snapshot, parent_interaction_id)
          SELECT ${randomUUID()}, ${scope.workspaceId}, ${input.purpose}, ${input.amountCents}, ${input.amountCents}, ${input.requestId}, ${modelSnapshot === null ? null : tx.json(modelSnapshot)}, ${input.parentBudget?.id ?? null}
          WHERE ${zeroCost} OR ${input.amountCents} + COALESCE((
            SELECT sum(amount_cents) FROM opening_budget_reservations
            WHERE workspace_id=${scope.workspaceId} AND (
              state='reserved' OR
              (state='completed' AND created_at >= ${budgetDay.dayStart}
                AND created_at < ${budgetDay.nextDayStart})
            )
          ), 0) <= ${capCents}
          RETURNING *
        `;
        if (!rows.length) throw new OpeningBudgetError("BUDGET_EXCEEDED", "daily workspace budget exceeded");
        return mapReservation(rows[0] as Record<string, unknown>);
      });
      } catch (error) {
        // A concurrent reserve in ANOTHER workspace (different FOR UPDATE lock)
        // can win the global UNIQUE(request_id) race; map to a stable CONFLICT.
        if (isRequestIdUniqueViolation(error)) {
          throw new OpeningBudgetError("CONFLICT", "request already consumed or changed");
        }
        throw error;
      }
    },
    release(scope, requestId, reason = "not_sent") {
      return changeState(scope, { by: "requestId", value: requestId }, "released", { releaseReason: reason });
    },
    complete(scope, requestId, options = {}) {
      return changeState(scope, { by: "requestId", value: requestId }, "completed", { resultRef: options.resultRef });
    },
    async claimExecution(scope, reservationId) {
      const rows = await sql`
        UPDATE opening_budget_reservations
        SET execution_claimed_at = now(), updated_at = now()
        WHERE id = ${reservationId} AND ${inScope(scope)}
          AND state = 'reserved'
          AND execution_claimed_at IS NULL
          AND outcome_unknown_at IS NULL
        RETURNING id
      `;
      return rows.length === 1;
    },
    async settle(scope, reservationId, actualCents, options = {}) {
      if (!Number.isSafeInteger(actualCents) || actualCents < 0) {
        throw new OpeningBudgetError("CONFLICT", "actual amount must be a positive integer");
      }
      const resultRef = options.resultRef ?? null;
      const alerts: BudgetReconcileEvent[] = [];
      const settled = await sql.begin(async (tx) => {
        // Same lock order as reserve: an unexpectedly higher bill must be visible
        // before another parent call is authorized.
        const owners = await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
        if (!owners.length) throw new OpeningBudgetError("NOT_FOUND", "workspace not found");
        const current = await tx`
          SELECT * FROM opening_budget_reservations
          WHERE id = ${reservationId} AND ${inScope(scope)}
          FOR UPDATE
        `;
        if (!current.length) {
          throw new OpeningBudgetError("NOT_FOUND", "reservation not found or already settled");
        }
        const row = mapReservation(current[0] as Record<string, unknown>);
        // Zero only settles a zero-cost (free-tier) reservation; paid calls stay positive.
        if (actualCents === 0 && (row.reservedAmountCents ?? row.amountCents) !== 0) {
          throw new OpeningBudgetError("CONFLICT", "actual amount must be a positive integer");
        }
        if (actualCents > (row.reservedAmountCents ?? row.amountCents)) {
          if (row.parentInteractionId) {
            await tx`UPDATE opening_parent_interaction_budgets
              SET blocked_at = COALESCE(blocked_at, now()), blocked_reason = 'actual_exceeded_conservative_bound'
              WHERE workspace_id = ${scope.workspaceId} AND id = ${row.parentInteractionId}`;
          }
          const event = await tx`INSERT INTO opening_budget_reconcile_events
            (reservation_id, workspace_id, kind, amount_before_cents, amount_after_cents, reported_actual_cents, state_before, cap_cents)
            VALUES (${row.id}, ${row.workspaceId}, 'cap_overrun', ${row.amountCents}, ${actualCents}, ${actualCents}, ${row.state}, ${row.reservedAmountCents ?? row.amountCents})
            ON CONFLICT (reservation_id, kind) DO NOTHING RETURNING *`;
          if (event.length) alerts.push(mapEvent(event[0] as Record<string, unknown>));
        }
        if (row.state === "reserved") {
          const rows = await tx`
            UPDATE opening_budget_reservations
            SET amount_cents = ${actualCents}, state = 'completed', updated_at = now(),
                result_ref = COALESCE(${resultRef}, result_ref), outcome_unknown_at = NULL,
                settlement_cost_basis = ${options.costBasis ?? "usage_pricing"}
            WHERE id = ${reservationId}
            RETURNING *
          `;
          return mapReservation(rows[0] as Record<string, unknown>);
        }
        // Free-tier TTL reconciliation has no pending cents, but its receipt is
        // still late. The unique late_receipt event below permits it only once.
        const lateAfterReconcile = row.state === "completed" && ((row.reconciledAt !== null
          && (row.pendingReconcileCents > 0 || (row.reservedAmountCents === 0 && actualCents === 0)))
          || (row.settlementCostBasis === "media_usage_upper_bound" && options.costBasis === "vendor_receipt"));
        const lateAfterRelease = row.state === "released";
        if (!lateAfterReconcile && !lateAfterRelease) {
          // Normal completed row: duplicate receipt is rejected, never re-applied.
          throw new OpeningBudgetError("NOT_FOUND", "reservation not found or already settled");
        }
        // Late receipt: audited compensation. The provider DID run, so the real
        // cost is recorded (no loss), pending reconcile cleared exactly once.
        const events = await tx`
          INSERT INTO opening_budget_reconcile_events
            (reservation_id, workspace_id, kind, amount_before_cents, amount_after_cents, reported_actual_cents, state_before)
          VALUES (${row.id}, ${row.workspaceId}, 'late_receipt', ${lateAfterRelease ? 0 : row.amountCents}, ${actualCents}, ${actualCents}, ${row.state})
          ON CONFLICT (reservation_id, kind) DO NOTHING
          RETURNING id
        `;
        if (!events.length) {
          throw new OpeningBudgetError("NOT_FOUND", "reservation not found or already settled");
        }
        const rows = await tx`
          UPDATE opening_budget_reservations
          SET amount_cents = ${actualCents}, state = 'completed', pending_reconcile_cents = 0,
              reconciled_at = COALESCE(reconciled_at, now()), updated_at = now(),
              result_ref = COALESCE(${resultRef}, result_ref), outcome_unknown_at = NULL,
              settlement_cost_basis = ${options.costBasis ?? "usage_pricing"}
          WHERE id = ${reservationId}
          RETURNING *
        `;
        // A late receipt is real spend that bypassed the reserve-time cap
        // check. If it pushes local-day usage over the cap, record an audited
        // cap_overrun event and raise the alert hook: never silent.
        const { capCents, budgetDay } = await capAndDay(tx as unknown as Sql, row.workspaceId);
        const usage = await tx`
          SELECT COALESCE(sum(amount_cents), 0)::int AS used FROM opening_budget_reservations
          WHERE workspace_id = ${row.workspaceId} AND (
            state = 'reserved' OR
            (state = 'completed' AND created_at >= ${budgetDay.dayStart} AND created_at < ${budgetDay.nextDayStart})
          )
        `;
        const usageAfter = Number(usage[0]?.used ?? 0);
        if (usageAfter > capCents) {
          const overrun = await tx`
            INSERT INTO opening_budget_reconcile_events
              (reservation_id, workspace_id, kind, amount_before_cents, amount_after_cents, reported_actual_cents, state_before, cap_cents, usage_after_cents)
            VALUES (${row.id}, ${row.workspaceId}, 'cap_overrun', ${usageAfter - actualCents}, ${usageAfter}, ${actualCents}, ${row.state}, ${capCents}, ${usageAfter})
            ON CONFLICT (reservation_id, kind) DO NOTHING
            RETURNING *
          `;
          if (overrun.length) alerts.push(mapEvent(overrun[0] as Record<string, unknown>));
        }
        return mapReservation(rows[0] as Record<string, unknown>);
      });
      for (const alert of alerts) await onReconcileAlert?.(alert);
      return settled;
    },
    async listReconcileEvents(scope, filter = {}) {
      const kind = filter.kind ? sql`AND kind = ${filter.kind}` : sql``;
      const rows = await sql`
        SELECT * FROM opening_budget_reconcile_events
        WHERE ${inScope(scope)} ${kind}
        ORDER BY created_at, id
      `;
      return rows.map((r) => mapEvent(r as Record<string, unknown>));
    },
    async listPendingReconcile(scope) {
      const rows = await sql`
        SELECT * FROM opening_budget_reservations
        WHERE ${inScope(scope)} AND (pending_reconcile_cents > 0 OR settlement_cost_basis = 'media_usage_upper_bound')
        ORDER BY created_at, id
      `;
      return rows.map((r) => mapReservation(r as Record<string, unknown>));
    },
    async markUnknown(scope, reservationId) {
      // Outcome unknown: keep the reservation counted against the workspace
      // cap ('reserved') and flag it so it can never be released or re-sent;
      // lazy reconciliation completes it at TTL with a pending-reconcile record.
      const rows = await sql`
        UPDATE opening_budget_reservations
        SET outcome_unknown_at = COALESCE(outcome_unknown_at, now()), updated_at = now()
        WHERE id = ${reservationId} AND ${inScope(scope)} AND state = 'reserved'
        RETURNING *
      `;
      if (rows.length) return mapReservation(rows[0] as Record<string, unknown>);
      return byId(scope, reservationId);
    },
  };
}


/** Derive a compiler's parent from persisted, revalidated server-owned user-turn lineage. */
export async function readOpeningTeachingParentBudget(sql: Sql, scope: OpeningScope, activityId: string): Promise<ParentInteractionBudget> {
  const [activity] = await sql`SELECT a.course_id, a.create_intent FROM opening_teaching_activities a
    JOIN workspaces w ON w.id = a.workspace_id AND w.owner_user_id = ${scope.ownerUserId}
    WHERE a.id = ${activityId} AND a.workspace_id = ${scope.workspaceId} AND a.owner_user_id = ${scope.ownerUserId}`;
  if (!activity) throw new OpeningBudgetError("NOT_FOUND", "teaching activity not found");
  const sourceTurnId = (activity.create_intent as Record<string, unknown> | null)?.sourceTurnId;
  if (sourceTurnId === undefined) return { id: `study-activity:${activityId}` };
  if (typeof sourceTurnId !== "string") throw new OpeningBudgetError("CONFLICT", "invalid source user turn lineage");
  const turns = await sql`SELECT t.id FROM opening_turns t
    JOIN opening_conversations c ON c.id = t.conversation_id
    WHERE t.id::text = ${sourceTurnId} AND t.role = 'user'
      AND t.workspace_id = ${scope.workspaceId} AND c.workspace_id = ${scope.workspaceId}
      AND c.owner_user_id = ${scope.ownerUserId}
      AND c.course_id IS NOT DISTINCT FROM ${activity.course_id}::uuid`;
  if (!turns.length) throw new OpeningBudgetError("NOT_FOUND", "source user turn lineage is no longer available");
  return { id: `study-turn:${sourceTurnId}` };
}
