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
  const normalized = value.toLowerCase();
  return normalized.startsWith(DAY_EXCEPTION_PROPOSE_KEY_PREFIX)
    || normalized.startsWith(DAY_ADJUSTMENT_PROPOSE_KEY_PREFIX);
}

/**
 * Recognizes the canonical ordinary proposePlan / ensureAutoDraft input_snapshot shape
 * (tasks + free arrays plus ordinary metadata, with no dayException/dayAdjustment markers),
 * so pre-existing legacy ordinary drafts (strategy_version === null) whose propose_client_key
 * happened to match day-exception:<UUID> or day-adjustment:<UUID> are not misclassified.
 */
export function hasLegacyOrdinaryPlanSnapshot(inputSnapshot: unknown): boolean {
  if (!inputSnapshot || typeof inputSnapshot !== "object" || Array.isArray(inputSnapshot)) {
    return false;
  }
  const snap = inputSnapshot as Record<string, unknown>;
  if (snap.dayException !== undefined || snap.dayAdjustment !== undefined) {
    return false;
  }
  return (
    Array.isArray(snap.tasks)
    && Array.isArray(snap.free)
    && (
      (typeof snap.proposedAt === "string" && Number.isFinite(Date.parse(snap.proposedAt)))
      || snap.autoDraft === true
      || Array.isArray(snap.unscheduledReasons)
    )
  );
}

/**
 * Matches only strict UUID-suffixed internal day-exception propose_client_key markers,
 * excluding drafts that carry another known legacy strategy_version (e.g. local-replan-v1)
 * or a legacy ordinary proposePlan snapshot without strategy_version.
 */
export function isReservedDayExceptionProposeKey(
  proposeClientKey: unknown,
  strategyVersion?: unknown,
  inputSnapshot?: unknown,
): boolean {
  if (typeof proposeClientKey !== "string") return false;
  if (typeof strategyVersion === "string" && OTHER_KNOWN_DRAFT_STRATEGIES.has(strategyVersion)) {
    return false;
  }
  if (strategyVersion == null && hasLegacyOrdinaryPlanSnapshot(inputSnapshot)) {
    return false;
  }
  return DAY_EXCEPTION_RESERVED_PROPOSE_KEY_RE.test(proposeClientKey);
}

/**
 * Matches only strict UUID-suffixed internal day-adjustment propose_client_key markers,
 * excluding drafts that carry another known legacy strategy_version (e.g. local-replan-v1)
 * or a legacy ordinary proposePlan snapshot without strategy_version.
 * When draftId is supplied and proposeClientKey strictly matches `day-adjustment:<draftId>`
 * (UUID, case-insensitive), it is always treated as an internal day-adjustment key regardless
 * of strategy_version or snapshot shape, because ordinary proposePlan receives the client key
 * before generating draft.id.
 */
export function isReservedDayAdjustmentProposeKey(
  proposeClientKey: unknown,
  strategyVersion?: unknown,
  inputSnapshot?: unknown,
  draftId?: unknown,
): boolean {
  if (typeof proposeClientKey !== "string") return false;
  const trimmedKey = proposeClientKey.trim();
  if (
    typeof draftId === "string"
    && draftId.trim().length > 0
    && trimmedKey.toLowerCase() === `${DAY_ADJUSTMENT_PROPOSE_KEY_PREFIX}${draftId.trim().toLowerCase()}`
    && DAY_ADJUSTMENT_RESERVED_PROPOSE_KEY_RE.test(trimmedKey)
  ) {
    return true;
  }
  if (typeof strategyVersion === "string" && OTHER_KNOWN_DRAFT_STRATEGIES.has(strategyVersion)) {
    return false;
  }
  if (strategyVersion == null && hasLegacyOrdinaryPlanSnapshot(inputSnapshot)) {
    return false;
  }
  return DAY_ADJUSTMENT_RESERVED_PROPOSE_KEY_RE.test(trimmedKey);
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
