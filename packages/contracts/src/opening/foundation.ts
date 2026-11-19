import { z } from "zod";

/** Pinned Docling release for opening ingestion (I02). Formula enrichment defaults OFF. */
export const DOCLING_PINNED_VERSION = "2.126.0" as const;

export const uuidSchema = z.string().uuid();
export const isoDateTimeSchema = z.string().datetime();
export const sha256HexSchema = z
  .string()
  .length(64)
  .regex(/^[a-f0-9]{64}$/i, "sha256 must be 64 hex chars");

export const scopeSchema = z
  .object({
    workspaceId: uuidSchema,
    ownerUserId: uuidSchema,
  })
  .strict();

export const apiFailureSchema = z
  .object({
    code: z.string().min(1).max(120),
    message: z.string().min(1).max(2000),
    retryable: z.boolean(),
  })
  .strict();

export type Scope = z.infer<typeof scopeSchema>;
export type ApiFailure = z.infer<typeof apiFailureSchema>;

/** Calendar day, validated before SQL date casts or timezone conversion. */
export const calendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, "invalid calendar date");

export const DAY_EXCEPTION_PROPOSE_KEY_PREFIX = "day-exception:" as const;
export const DAY_ADJUSTMENT_PROPOSE_KEY_PREFIX = "day-adjustment:" as const;

export const DAY_EXCEPTION_RESERVED_PROPOSE_KEY_RE =
  /^day-exception:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DAY_ADJUSTMENT_RESERVED_PROPOSE_KEY_RE =
  /^day-adjustment:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const OTHER_KNOWN_DRAFT_STRATEGIES = new Set(["local-replan-v1", "adaptive-1"]);

export function isReservedDayAdjustmentProposePrefix(value: string): boolean {
  return value.startsWith(DAY_EXCEPTION_PROPOSE_KEY_PREFIX)
    || value.startsWith(DAY_ADJUSTMENT_PROPOSE_KEY_PREFIX);
}

/**
 * Matches only strict UUID-suffixed internal day-exception propose_client_key markers,
 * excluding drafts that carry another known legacy strategy_version (e.g. local-replan-v1).
 */
export function isReservedDayExceptionProposeKey(
  proposeClientKey: unknown,
  strategyVersion?: unknown,
): boolean {
  if (typeof proposeClientKey !== "string") return false;
  if (typeof strategyVersion === "string" && OTHER_KNOWN_DRAFT_STRATEGIES.has(strategyVersion)) {
    return false;
  }
  return DAY_EXCEPTION_RESERVED_PROPOSE_KEY_RE.test(proposeClientKey);
}

/**
 * Matches only strict UUID-suffixed internal day-adjustment propose_client_key markers,
 * excluding drafts that carry another known legacy strategy_version (e.g. local-replan-v1).
 */
export function isReservedDayAdjustmentProposeKey(
  proposeClientKey: unknown,
  strategyVersion?: unknown,
): boolean {
  if (typeof proposeClientKey !== "string") return false;
  if (typeof strategyVersion === "string" && OTHER_KNOWN_DRAFT_STRATEGIES.has(strategyVersion)) {
    return false;
  }
  return DAY_ADJUSTMENT_RESERVED_PROPOSE_KEY_RE.test(proposeClientKey);
}

/**
 * Client key schema for non-day-adjustment draft creation endpoints:
 * rejects reserved day-exception:/day-adjustment: prefixes on new submissions.
 */
export const ordinaryPlanClientKeySchema = z
  .string()
  .min(8)
  .max(200)
  .refine(
    (value) => !isReservedDayAdjustmentProposePrefix(value),
    "clientKey cannot start with reserved day-exception: or day-adjustment: prefix",
  );
