/**
 * TZ01 / DL7 — AI budget day keys consume the shared domain day-boundary.
 * Do not fork another local-day calculator here.
 */
import {
  localDateKeyInZone,
  resolveLocalDayBounds,
  type LocalDayBounds,
} from "@aistudy/domain";

/** Aligned with planning-settings / DL7 / plan-service DEFAULT_PLANNING_TIME_ZONE. */
export const DEFAULT_BUDGET_TIME_ZONE = "Asia/Shanghai";

export type BudgetLocalDay = LocalDayBounds & {
  /** YYYY-MM-DD in the workspace IANA zone. */
  localDate: string;
  timeZone: string;
};

/**
 * Resolve workspace IANA zone for budget day accounting.
 * Empty / missing → DEFAULT_BUDGET_TIME_ZONE (Asia/Shanghai).
 */
export function resolveBudgetTimeZone(planningTimeZone: string | null | undefined): string {
  if (typeof planningTimeZone === "string" && planningTimeZone.trim().length > 0) {
    return planningTimeZone.trim();
  }
  return DEFAULT_BUDGET_TIME_ZONE;
}

/**
 * Local calendar day for ledger reserve/settle day keys and readiness spend.
 * Half-open [dayStart, nextDayStart) absolute instants from resolveLocalDayBounds.
 */
export function resolveBudgetLocalDay(
  now: Date | string | number = new Date(),
  timeZone: string = DEFAULT_BUDGET_TIME_ZONE,
): BudgetLocalDay {
  const instant = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(instant.getTime())) {
    throw new RangeError("invalid budget day instant");
  }
  const tz = resolveBudgetTimeZone(timeZone);
  const localDate = localDateKeyInZone(instant, tz);
  const bounds = resolveLocalDayBounds(localDate, tz);
  return { localDate, timeZone: tz, ...bounds };
}

/** True when absolute instant falls on the same local budget day as `now`. */
export function isInstantOnBudgetLocalDay(
  instant: Date | string | number,
  now: Date | string | number,
  timeZone: string = DEFAULT_BUDGET_TIME_ZONE,
): boolean {
  const day = resolveBudgetLocalDay(now, timeZone);
  const t = instant instanceof Date ? instant.getTime() : new Date(instant).getTime();
  if (!Number.isFinite(t)) throw new RangeError("invalid instant");
  return t >= day.dayStart.getTime() && t < day.nextDayStart.getTime();
}
