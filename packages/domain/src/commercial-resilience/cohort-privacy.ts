/**
 * Zero-solo-pollution bilateral-privacy cohort heatmap & pure LTI 1.3
 * deep-linking claims validator.
 *
 * Privacy invariants:
 *   1. Solo learners (`mode: "solo"`) receive zero cohort queries/widgets
 *      (`cohortSurfaceVisible: false`).
 *   2. Cohort heatmap aggregation is locked strictly to immutable ISO-8601
 *      calendar week boundaries `[Monday 00:00:00.000 UTC, next Monday 00:00:00.000 UTC)`.
 *      Sliding or arbitrary time windows are deterministically rejected to
 *      block single-student differencing attacks.
 *   3. Every skill/concept cell is suppressed unless ALL THREE hold:
 *        N >= 10 && E >= 5 && (N - E) >= 5
 *      Suppressed cells emit a uniform non-leaking reason and null counts/rates.
 *   4. LTI 1.3 deep-linking validation strictly enforces iss, aud/azp,
 *      deployment_id, nonce, exp/iat, version 1.3.0, target cartridge/course
 *      resource link, IMS LIS role mapping, and hard denial of solo learner
 *      private notes and raw attempt transcripts.
 */

import {
  assertNonNegativeSafeInteger,
  assertSafeTimestampMs,
  CommercialResilienceError,
  DAY_MS,
  normalizeIdentifier,
  WEEK_MS,
} from "./types";

export const MIN_COHORT_ACTIVE_SIZE = 10;
export const MIN_BILATERAL_CLASS_COUNT = 5;

/** 1970-01-05T00:00:00.000Z — the first Monday after the Unix epoch (1970-01-01 was Thursday). */
const FIRST_UTC_MONDAY_MS = 4 * DAY_MS;

/* ============================================================================
 * 1. Zero-Solo-Pollution Surface Policy
 * ========================================================================== */

export type WorkspaceLearningMode = "solo" | "cohort";
export type CohortViewerRole = "learner" | "instructor" | "admin";

export interface CohortSurfacePolicyInput {
  readonly mode: WorkspaceLearningMode;
  readonly role: CohortViewerRole;
}

export interface CohortSurfacePolicy {
  readonly mode: WorkspaceLearningMode;
  readonly role: CohortViewerRole;
  readonly cohortSurfaceVisible: boolean;
  readonly allowCohortQueries: boolean;
  readonly widgets: ReadonlyArray<"cohort_iso_week_heatmap">;
  readonly allowPrivateSoloNotesAccess: false;
  readonly allowRawAttemptTranscriptAccess: false;
  readonly reason:
    | "solo_mode_isolated"
    | "cohort_learner_isolated"
    | "cohort_instructor_aggregated_only";
}

export function resolveCohortSurfacePolicy(
  input: CohortSurfacePolicyInput,
): CohortSurfacePolicy {
  if (input.mode === "solo") {
    return {
      mode: "solo",
      role: input.role,
      cohortSurfaceVisible: false,
      allowCohortQueries: false,
      widgets: [],
      allowPrivateSoloNotesAccess: false,
      allowRawAttemptTranscriptAccess: false,
      reason: "solo_mode_isolated",
    };
  }

  if (input.role === "instructor" || input.role === "admin") {
    return {
      mode: "cohort",
      role: input.role,
      cohortSurfaceVisible: true,
      allowCohortQueries: true,
      widgets: ["cohort_iso_week_heatmap"],
      allowPrivateSoloNotesAccess: false,
      allowRawAttemptTranscriptAccess: false,
      reason: "cohort_instructor_aggregated_only",
    };
  }

  return {
    mode: "cohort",
    role: input.role,
    cohortSurfaceVisible: false,
    allowCohortQueries: false,
    widgets: [],
    allowPrivateSoloNotesAccess: false,
    allowRawAttemptTranscriptAccess: false,
    reason: "cohort_learner_isolated",
  };
}

/* ============================================================================
 * 2. Immutable ISO Calendar Week Windows & Bilateral-Privacy Cohort Heatmap
 * ========================================================================== */

export interface IsoWeekWindow {
  readonly isoWeekKey: string;
  readonly isoYear: number;
  readonly isoWeek: number;
  readonly weekStartUtcMs: number;
  readonly weekEndUtcMs: number;
}

export function isIsoWeekBoundaryUtcMs(utcMs: number): boolean {
  if (typeof utcMs !== "number" || !Number.isSafeInteger(utcMs) || utcMs < 0) {
    return false;
  }
  const offset = (((utcMs - FIRST_UTC_MONDAY_MS) % WEEK_MS) + WEEK_MS) % WEEK_MS;
  return offset === 0;
}

/**
 * Computes the ISO-8601 week key (`YYYY-Www`) and exact `[Monday 00:00 UTC,
 * next Monday 00:00 UTC)` bounds containing `utcMs`.
 */
export function getIsoWeekWindowForTimestamp(utcMs: number): IsoWeekWindow {
  const safeUtcMs = assertSafeTimestampMs(utcMs, "utcMs");
  const shifted = safeUtcMs - FIRST_UTC_MONDAY_MS;
  const weekIndex = Math.floor(shifted / WEEK_MS);
  const weekStartUtcMs = FIRST_UTC_MONDAY_MS + weekIndex * WEEK_MS;
  const weekEndUtcMs = weekStartUtcMs + WEEK_MS;

  // ISO-8601 rule: a week belongs to the calendar year containing its Thursday.
  const thursdayMs = weekStartUtcMs + 3 * DAY_MS;
  const thursdayDate = new Date(thursdayMs);
  const isoYear = thursdayDate.getUTCFullYear();
  const jan4Ms = Date.UTC(isoYear, 0, 4);
  const jan4WeekIndex = Math.floor((jan4Ms - FIRST_UTC_MONDAY_MS) / WEEK_MS);
  const isoWeek = weekIndex - jan4WeekIndex + 1;
  const isoWeekKey = `${isoYear}-W${String(isoWeek).padStart(2, "0")}`;

  return {
    isoWeekKey,
    isoYear,
    isoWeek,
    weekStartUtcMs,
    weekEndUtcMs,
  };
}

/**
 * Parses an ISO-8601 week key (`YYYY-Www`) into its exact immutable UTC bounds.
 * Rejects nonexistent week numbers (e.g. `W53` in a 52-week ISO year).
 */
export function parseIsoWeekKey(isoWeekKey: string): IsoWeekWindow {
  const trimmed = normalizeIdentifier(isoWeekKey, "isoWeekKey");
  const match = /^(\d{4})-W(\d{2})$/.exec(trimmed);
  if (!match) {
    throw new CommercialResilienceError(
      "SLIDING_OR_INVALID_WEEK_WINDOW",
      `Invalid ISO week key "${isoWeekKey}"; expected YYYY-Www`,
    );
  }
  const year = Number(match[1]);
  const week = Number(match[2]);
  if (year < 1971 || week < 1 || week > 53) {
    throw new CommercialResilienceError(
      "SLIDING_OR_INVALID_WEEK_WINDOW",
      `Out-of-range ISO week key "${isoWeekKey}"`,
    );
  }

  const jan4Ms = Date.UTC(year, 0, 4);
  const week1Index = Math.floor((jan4Ms - FIRST_UTC_MONDAY_MS) / WEEK_MS);
  const weekStartUtcMs =
    FIRST_UTC_MONDAY_MS + (week1Index + week - 1) * WEEK_MS;
  const window = getIsoWeekWindowForTimestamp(weekStartUtcMs);

  if (window.isoYear !== year || window.isoWeek !== week) {
    throw new CommercialResilienceError(
      "SLIDING_OR_INVALID_WEEK_WINDOW",
      `ISO year ${year} does not contain week W${String(week).padStart(2, "0")}`,
    );
  }
  return window;
}

/**
 * Validates that `[weekStartUtcMs, weekEndUtcMs)` is an exact single immutable
 * ISO calendar week boundary (`Monday 00:00:00.000 UTC` to next Monday).
 * Rejects sliding, shifted, partial, or multi-week windows.
 */
export function validateFixedIsoWeekWindow(window: {
  readonly weekStartUtcMs: number;
  readonly weekEndUtcMs: number;
}): IsoWeekWindow {
  const start = assertSafeTimestampMs(window.weekStartUtcMs, "weekStartUtcMs");
  const end = assertSafeTimestampMs(window.weekEndUtcMs, "weekEndUtcMs");

  if (!isIsoWeekBoundaryUtcMs(start)) {
    throw new CommercialResilienceError(
      "SLIDING_OR_INVALID_WEEK_WINDOW",
      "weekStartUtcMs must align exactly to Monday 00:00:00.000 UTC (sliding windows are forbidden)",
    );
  }
  if (end - start !== WEEK_MS) {
    throw new CommercialResilienceError(
      "SLIDING_OR_INVALID_WEEK_WINDOW",
      "Aggregation window must span exactly one immutable ISO calendar week (604,800,000 ms)",
    );
  }

  return getIsoWeekWindowForTimestamp(start);
}

export interface BilateralCohortCellInput {
  readonly skillId: string;
  readonly enrolledActiveCount: number;
  readonly eventLearnerCount: number;
}

export type BilateralCohortCell =
  | {
      readonly skillId: string;
      readonly suppressed: false;
      readonly enrolledActiveCount: number;
      readonly eventLearnerCount: number;
      readonly complementLearnerCount: number;
      readonly eventRate: number;
      readonly eventRateBps: number;
      readonly suppressionReason: null;
    }
  | {
      readonly skillId: string;
      readonly suppressed: true;
      readonly enrolledActiveCount: null;
      readonly eventLearnerCount: null;
      readonly complementLearnerCount: null;
      readonly eventRate: null;
      readonly eventRateBps: null;
      /** Uniform reason — never leaks whether E < 5 or N - E < 5. */
      readonly suppressionReason: "bilateral_privacy_threshold";
    };

/**
 * Applies the bilateral differential-privacy threshold gate:
 *   disclosed iff N >= 10 && E >= 5 && (N - E) >= 5.
 */
export function evaluateBilateralPrivacyCell(
  input: BilateralCohortCellInput,
): BilateralCohortCell {
  const skillId = normalizeIdentifier(input.skillId, "skillId");
  const n = assertNonNegativeSafeInteger(
    input.enrolledActiveCount,
    "enrolledActiveCount",
  );
  const e = assertNonNegativeSafeInteger(
    input.eventLearnerCount,
    "eventLearnerCount",
  );

  if (e > n) {
    throw new CommercialResilienceError(
      "INVALID_COHORT_COUNTS",
      `eventLearnerCount (${e}) cannot exceed enrolledActiveCount (${n}) for skill "${skillId}"`,
    );
  }

  const complement = n - e;
  const disclosed =
    n >= MIN_COHORT_ACTIVE_SIZE &&
    e >= MIN_BILATERAL_CLASS_COUNT &&
    complement >= MIN_BILATERAL_CLASS_COUNT;

  if (!disclosed) {
    return {
      skillId,
      suppressed: true,
      enrolledActiveCount: null,
      eventLearnerCount: null,
      complementLearnerCount: null,
      eventRate: null,
      eventRateBps: null,
      suppressionReason: "bilateral_privacy_threshold",
    };
  }

  return {
    skillId,
    suppressed: false,
    enrolledActiveCount: n,
    eventLearnerCount: e,
    complementLearnerCount: complement,
    eventRate: e / n,
    eventRateBps: Math.round((e * 10_000) / n),
    suppressionReason: null,
  };
}

export interface CohortHeatmapInput {
  readonly mode: WorkspaceLearningMode;
  readonly role: CohortViewerRole;
  readonly window: {
    readonly weekStartUtcMs: number;
    readonly weekEndUtcMs: number;
  };
  readonly cells: ReadonlyArray<BilateralCohortCellInput>;
}

export interface CohortHeatmapResult {
  readonly cohortSurfaceVisible: boolean;
  readonly window: IsoWeekWindow | null;
  readonly cells: ReadonlyArray<BilateralCohortCell>;
  readonly disclosedCellCount: number;
  readonly suppressedCellCount: number;
}

/**
 * Produces a bilateral-privacy-gated cohort heatmap locked to an immutable ISO
 * calendar week. Solo learners (and cohort learners) receive zero cohort UI or
 * query results (`cohortSurfaceVisible: false`, `cells: []`).
 */
export function buildCohortHeatmap(
  input: CohortHeatmapInput,
): CohortHeatmapResult {
  const policy = resolveCohortSurfacePolicy({
    mode: input.mode,
    role: input.role,
  });

  if (!policy.cohortSurfaceVisible || !policy.allowCohortQueries) {
    return {
      cohortSurfaceVisible: false,
      window: null,
      cells: [],
      disclosedCellCount: 0,
      suppressedCellCount: 0,
    };
  }

  const validatedWindow = validateFixedIsoWeekWindow(input.window);
  const evaluatedCells = input.cells.map((cell) =>
    evaluateBilateralPrivacyCell(cell),
  );

  let disclosedCellCount = 0;
  let suppressedCellCount = 0;
  for (const cell of evaluatedCells) {
    if (cell.suppressed) {
      suppressedCellCount += 1;
    } else {
      disclosedCellCount += 1;
    }
  }

  return {
    cohortSurfaceVisible: true,
    window: validatedWindow,
    cells: evaluatedCells,
    disclosedCellCount,
    suppressedCellCount,
  };
}

export interface CohortSkillEventRecord {
  readonly learnerId: string;
  readonly skillId: string;
  readonly occurredAtMs: number;
}

export interface AggregateCohortEventsInput {
  readonly mode: WorkspaceLearningMode;
  readonly role: CohortViewerRole;
  readonly window: {
    readonly weekStartUtcMs: number;
    readonly weekEndUtcMs: number;
  };
  readonly enrolledActiveLearnerIds: ReadonlyArray<string>;
  readonly skillIds: ReadonlyArray<string>;
  readonly events: ReadonlyArray<CohortSkillEventRecord>;
}

/**
 * Deduplicates learner-level events inside a fixed ISO calendar week against
 * the enrolled active cohort before evaluating the bilateral privacy gate,
 * preventing a single learner from inflating `E` via repeated submissions.
 */
export function aggregateCohortEventsToHeatmap(
  input: AggregateCohortEventsInput,
): CohortHeatmapResult {
  const policy = resolveCohortSurfacePolicy({
    mode: input.mode,
    role: input.role,
  });

  if (!policy.cohortSurfaceVisible || !policy.allowCohortQueries) {
    return {
      cohortSurfaceVisible: false,
      window: null,
      cells: [],
      disclosedCellCount: 0,
      suppressedCellCount: 0,
    };
  }

  const validatedWindow = validateFixedIsoWeekWindow(input.window);
  const enrolledSet = new Set(
    input.enrolledActiveLearnerIds.map((id, idx) =>
      normalizeIdentifier(id, `enrolledActiveLearnerIds[${idx}]`),
    ),
  );
  const distinctSkillIds: string[] = [];
  const seenSkills = new Set<string>();
  for (const [i, rawSkillId] of input.skillIds.entries()) {
    const skillId = normalizeIdentifier(rawSkillId, `skillIds[${i}]`);
    if (!seenSkills.has(skillId)) {
      seenSkills.add(skillId);
      distinctSkillIds.push(skillId);
    }
  }

  const learnersBySkill = new Map<string, Set<string>>();
  for (const skillId of distinctSkillIds) {
    learnersBySkill.set(skillId, new Set<string>());
  }

  for (const [i, ev] of input.events.entries()) {
    const learnerId = normalizeIdentifier(
      ev.learnerId,
      `events[${i}].learnerId`,
    );
    const skillId = normalizeIdentifier(ev.skillId, `events[${i}].skillId`);
    const occurredAtMs = assertSafeTimestampMs(
      ev.occurredAtMs,
      `events[${i}].occurredAtMs`,
    );

    if (
      occurredAtMs < validatedWindow.weekStartUtcMs ||
      occurredAtMs >= validatedWindow.weekEndUtcMs
    ) {
      continue;
    }
    if (!enrolledSet.has(learnerId)) {
      continue;
    }
    const bucket = learnersBySkill.get(skillId);
    if (bucket) {
      bucket.add(learnerId);
    }
  }

  const n = enrolledSet.size;
  const cells: BilateralCohortCellInput[] = distinctSkillIds.map((skillId) => ({
    skillId,
    enrolledActiveCount: n,
    eventLearnerCount: learnersBySkill.get(skillId)?.size ?? 0,
  }));

  return buildCohortHeatmap({
    mode: input.mode,
    role: input.role,
    window: {
      weekStartUtcMs: validatedWindow.weekStartUtcMs,
      weekEndUtcMs: validatedWindow.weekEndUtcMs,
    },
    cells,
  });
}

/* ============================================================================
 * 3. Pure LTI 1.3 Deep-Linking Payload & Claims Validator
 * ========================================================================== */

export const LTI_13_VERSION = "1.3.0";
export const LTI_CLAIM_MESSAGE_TYPE =
  "https://purl.imsglobal.org/spec/lti/claim/message_type";
export const LTI_CLAIM_VERSION =
  "https://purl.imsglobal.org/spec/lti/claim/version";
export const LTI_CLAIM_DEPLOYMENT_ID =
  "https://purl.imsglobal.org/spec/lti/claim/deployment_id";
export const LTI_CLAIM_ROLES =
  "https://purl.imsglobal.org/spec/lti/claim/roles";
export const LTI_CLAIM_CONTEXT =
  "https://purl.imsglobal.org/spec/lti/claim/context";
export const LTI_CLAIM_RESOURCE_LINK =
  "https://purl.imsglobal.org/spec/lti/claim/resource_link";
export const LTI_CLAIM_DEEP_LINKING_SETTINGS =
  "https://purl.imsglobal.org/spec/lti-dl/claim/deep_linking_settings";
export const LTI_CLAIM_CUSTOM =
  "https://purl.imsglobal.org/spec/lti/claim/custom";

export type Lti13MessageType =
  | "LtiDeepLinkingRequest"
  | "LtiResourceLinkRequest";

export interface Lti13DeepLinkingSettingsClaim {
  readonly deep_link_return_url?: string;
  readonly accept_types?: ReadonlyArray<string>;
  readonly accept_presentation_document_targets?: ReadonlyArray<string>;
  readonly accept_multiple?: boolean;
  readonly data?: string;
}

export interface Lti13ResourceLinkClaim {
  readonly id?: string;
  readonly title?: string;
  readonly target_link_uri?: string;
}

export interface Lti13ContextClaim {
  readonly id?: string;
  readonly label?: string;
  readonly title?: string;
}

export interface Lti13DeepLinkingClaimsPayload {
  readonly iss?: string;
  readonly sub?: string;
  readonly aud?: string | ReadonlyArray<string>;
  readonly azp?: string;
  readonly nonce?: string;
  readonly exp?: number;
  readonly iat?: number;
  readonly [LTI_CLAIM_VERSION]?: string;
  readonly [LTI_CLAIM_MESSAGE_TYPE]?: string;
  readonly [LTI_CLAIM_DEPLOYMENT_ID]?: string;
  readonly [LTI_CLAIM_ROLES]?: ReadonlyArray<string>;
  readonly [LTI_CLAIM_CONTEXT]?: Lti13ContextClaim;
  readonly [LTI_CLAIM_RESOURCE_LINK]?: Lti13ResourceLinkClaim;
  readonly [LTI_CLAIM_DEEP_LINKING_SETTINGS]?: Lti13DeepLinkingSettingsClaim;
  readonly [LTI_CLAIM_CUSTOM]?: Readonly<Record<string, unknown>>;
}

export interface Lti13ValidationPolicy {
  readonly expectedIssuer: string;
  readonly expectedClientId: string;
  readonly allowedDeploymentIds: ReadonlyArray<string>;
  readonly nowMs: number;
  readonly maxClockSkewSeconds?: number;
  readonly usedNonces?: ReadonlySet<string>;
  readonly allowedMessageTypes?: ReadonlyArray<Lti13MessageType>;
  readonly allowedReturnOrigins?: ReadonlyArray<string>;
  readonly allowedCartridgeIds?: ReadonlyArray<string>;
  readonly allowedCourseIds?: ReadonlyArray<string>;
}

export type Lti13ValidationErrorCode =
  | "INVALID_ISSUER"
  | "INVALID_CLIENT_ID"
  | "INVALID_SUBJECT"
  | "INVALID_DEPLOYMENT_ID"
  | "INVALID_NONCE"
  | "NONCE_REPLAYED"
  | "TOKEN_EXPIRED"
  | "INVALID_TIMESTAMPS"
  | "INVALID_VERSION"
  | "INVALID_MESSAGE_TYPE"
  | "INVALID_DEEP_LINKING_SETTINGS"
  | "INVALID_TARGET_RESOURCE_LINK"
  | "NO_VALID_LTI_ROLE"
  | "FORBIDDEN_PRIVACY_SCOPE";

export interface Lti13ValidationIssue {
  readonly code: Lti13ValidationErrorCode;
  readonly message: string;
}

export interface Lti13PrivacyBoundary {
  readonly canViewAggregatedCohortHeatmap: boolean;
  readonly canAccessSoloLearnerPrivateNotes: false;
  readonly canAccessRawAttemptTranscripts: false;
  readonly canQuerySlidingTimeWindows: false;
}

export interface ValidatedLti13DeepLinkingContext {
  readonly issuer: string;
  readonly clientId: string;
  readonly deploymentId: string;
  readonly subject: string;
  readonly nonce: string;
  readonly messageType: Lti13MessageType;
  readonly expiresAtMs: number;
  readonly issuedAtMs: number;
  readonly contextId: string | null;
  readonly targetResourceLink: {
    readonly resourceLinkId: string;
    readonly cartridgeId: string | null;
    readonly courseId: string | null;
    readonly targetLinkUri: string | null;
  };
  readonly deepLinkReturnUrl: string | null;
  readonly mappedRole: CohortViewerRole;
  readonly matchedRoleUris: ReadonlyArray<string>;
  readonly privacyBoundary: Lti13PrivacyBoundary;
}

export type Lti13ValidationResult =
  | {
      readonly valid: true;
      readonly context: ValidatedLti13DeepLinkingContext;
      readonly errors: readonly [];
    }
  | {
      readonly valid: false;
      readonly context: null;
      readonly errors: ReadonlyArray<Lti13ValidationIssue>;
    };

const IMS_ADMIN_ROLE_URIS: ReadonlySet<string> = new Set([
  "http://purl.imsglobal.org/vocab/lis/v2/institution/person#Administrator",
  "http://purl.imsglobal.org/vocab/lis/v2/system/person#Administrator",
  "http://purl.imsglobal.org/vocab/lis/v2/membership#Administrator",
]);

const IMS_INSTRUCTOR_ROLE_URIS: ReadonlySet<string> = new Set([
  "http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor",
  "http://purl.imsglobal.org/vocab/lis/v2/membership#ContentDeveloper",
  "http://purl.imsglobal.org/vocab/lis/v2/membership/Instructor#TeachingAssistant",
  "http://purl.imsglobal.org/vocab/lis/v2/institution/person#Instructor",
  "http://purl.imsglobal.org/vocab/lis/v2/institution/person#Faculty",
]);

const IMS_LEARNER_ROLE_URIS: ReadonlySet<string> = new Set([
  "http://purl.imsglobal.org/vocab/lis/v2/membership#Learner",
  "http://purl.imsglobal.org/vocab/lis/v2/institution/person#Learner",
  "http://purl.imsglobal.org/vocab/lis/v2/institution/person#Student",
]);

const SAFE_RESOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const FORBIDDEN_PRIVACY_CUSTOM_KEYS: ReadonlySet<string> = new Set([
  "solo_private_notes",
  "private_notes",
  "include_solo_notes",
  "raw_attempt_transcripts",
  "attempt_transcripts",
  "include_raw_transcripts",
]);

function isForbiddenPrivacyClaimValue(value: unknown): boolean {
  if (value === null || value === undefined || value === false) {
    return false;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return !Number.isNaN(value) && value !== 0;
  }
  if (typeof value === "bigint") {
    return value !== 0n;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized !== "" && normalized !== "false" && normalized !== "0";
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return true;
}

function parseHttpsUrl(raw: string | undefined): URL | null {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "https:" ? parsed : null;
  } catch {
    return null;
  }
}

function isSafeResourceIdentifier(value: string | undefined): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  return (
    SAFE_RESOURCE_ID_PATTERN.test(trimmed) && !trimmed.includes("..")
  );
}

function mapImsLtiRoles(rawRoles: ReadonlyArray<string> | undefined): {
  readonly mappedRole: CohortViewerRole | null;
  readonly matchedRoleUris: ReadonlyArray<string>;
} {
  if (!Array.isArray(rawRoles)) {
    return { mappedRole: null, matchedRoleUris: [] };
  }

  let hasAdmin = false;
  let hasInstructor = false;
  let hasLearner = false;
  const matched: string[] = [];

  for (const role of rawRoles) {
    if (typeof role !== "string") {
      continue;
    }
    const normalized = role.trim();
    if (IMS_ADMIN_ROLE_URIS.has(normalized)) {
      hasAdmin = true;
      matched.push(normalized);
    } else if (IMS_INSTRUCTOR_ROLE_URIS.has(normalized)) {
      hasInstructor = true;
      matched.push(normalized);
    } else if (IMS_LEARNER_ROLE_URIS.has(normalized)) {
      hasLearner = true;
      matched.push(normalized);
    }
  }

  if (hasAdmin) {
    return { mappedRole: "admin", matchedRoleUris: matched };
  }
  if (hasInstructor) {
    return { mappedRole: "instructor", matchedRoleUris: matched };
  }
  if (hasLearner) {
    return { mappedRole: "learner", matchedRoleUris: matched };
  }
  return { mappedRole: null, matchedRoleUris: [] };
}

/**
 * Pure fail-closed LTI 1.3 deep-linking claims & resource-link validator.
 * Rejects invalid issuer, client_id/azp, deployment_id, nonce replay, expired
 * tokens, unsafe resource links, unrecognized roles, and any attempt to
 * request solo learner private notes or raw attempt transcripts.
 */
export function validateLti13DeepLinkingClaims(
  claims: Lti13DeepLinkingClaimsPayload,
  policy: Lti13ValidationPolicy,
): Lti13ValidationResult {
  const nowMs = assertSafeTimestampMs(policy.nowMs, "policy.nowMs");
  const maxClockSkewSeconds = assertNonNegativeSafeInteger(
    policy.maxClockSkewSeconds ?? 60,
    "policy.maxClockSkewSeconds",
  );
  const expectedIssuer = normalizeIdentifier(
    policy.expectedIssuer,
    "policy.expectedIssuer",
  );
  const expectedClientId = normalizeIdentifier(
    policy.expectedClientId,
    "policy.expectedClientId",
  );
  const allowedDeploymentIds = new Set(
    policy.allowedDeploymentIds.map((id, idx) =>
      normalizeIdentifier(id, `policy.allowedDeploymentIds[${idx}]`),
    ),
  );
  const allowedMessageTypes = new Set<Lti13MessageType>(
    policy.allowedMessageTypes ?? ["LtiDeepLinkingRequest"],
  );
  const allowedReturnOrigins = policy.allowedReturnOrigins
    ? new Set(policy.allowedReturnOrigins.map((origin) => origin.trim()))
    : null;
  const allowedCartridgeIds = policy.allowedCartridgeIds
    ? new Set(
        policy.allowedCartridgeIds.map((id, idx) =>
          normalizeIdentifier(id, `policy.allowedCartridgeIds[${idx}]`),
        ),
      )
    : null;
  const allowedCourseIds = policy.allowedCourseIds
    ? new Set(
        policy.allowedCourseIds.map((id, idx) =>
          normalizeIdentifier(id, `policy.allowedCourseIds[${idx}]`),
        ),
      )
    : null;

  const errors: Lti13ValidationIssue[] = [];

  // 1. Issuer (`iss`)
  const issuerUrl = parseHttpsUrl(claims.iss);
  const trimmedIssuer = typeof claims.iss === "string" ? claims.iss.trim() : "";
  if (!issuerUrl || trimmedIssuer !== expectedIssuer) {
    errors.push({
      code: "INVALID_ISSUER",
      message: "LTI 1.3 iss claim must be an exact registered https:// issuer",
    });
  }

  // 2. Client ID (`aud` + OIDC Core §3.1.3.7 `azp` validation)
  const rawAud = claims.aud;
  const azpPresent = claims.azp !== undefined;
  const azpMatchesClient =
    typeof claims.azp === "string" && claims.azp.trim() === expectedClientId;
  let audValid = false;
  if (typeof rawAud === "string") {
    audValid =
      rawAud.trim() === expectedClientId && (!azpPresent || azpMatchesClient);
  } else if (
    Array.isArray(rawAud) &&
    rawAud.length > 0 &&
    rawAud.every((item): item is string => typeof item === "string")
  ) {
    const trimmedAud = rawAud.map((item) => item.trim());
    const containsClient = trimmedAud.includes(expectedClientId);
    if (trimmedAud.length === 1) {
      audValid = containsClient && (!azpPresent || azpMatchesClient);
    } else if (trimmedAud.length > 1) {
      audValid = containsClient && azpMatchesClient;
    }
  }
  if (!audValid) {
    errors.push({
      code: "INVALID_CLIENT_ID",
      message:
        "LTI 1.3 aud (and azp when present or for multi-audience tokens) must match registered client_id",
    });
  }

  // 3. Subject (`sub`)
  const subject = typeof claims.sub === "string" ? claims.sub.trim() : "";
  if (subject.length === 0) {
    errors.push({
      code: "INVALID_SUBJECT",
      message: "LTI 1.3 sub claim must be a non-empty string",
    });
  }

  // 4. Deployment ID
  const deploymentId =
    typeof claims[LTI_CLAIM_DEPLOYMENT_ID] === "string"
      ? claims[LTI_CLAIM_DEPLOYMENT_ID].trim()
      : "";
  if (deploymentId.length === 0 || !allowedDeploymentIds.has(deploymentId)) {
    errors.push({
      code: "INVALID_DEPLOYMENT_ID",
      message: "LTI 1.3 deployment_id is missing or not registered",
    });
  }

  // 5. Nonce & replay protection
  const nonce = typeof claims.nonce === "string" ? claims.nonce.trim() : "";
  if (nonce.length === 0 || /\s/.test(nonce)) {
    errors.push({
      code: "INVALID_NONCE",
      message: "LTI 1.3 nonce must be a non-empty whitespace-free string",
    });
  } else if (policy.usedNonces?.has(nonce)) {
    errors.push({
      code: "NONCE_REPLAYED",
      message: `LTI 1.3 nonce "${nonce}" has already been consumed`,
    });
  }

  // 6. Expiration (`exp`) & issued-at (`iat`)
  const exp = claims.exp;
  const iat = claims.iat;
  const nowSeconds = Math.floor(nowMs / 1000);
  let validExp: number | null = null;
  let validIat: number | null = null;
  if (
    typeof exp !== "number" ||
    !Number.isSafeInteger(exp) ||
    typeof iat !== "number" ||
    !Number.isSafeInteger(iat) ||
    exp <= iat ||
    iat > nowSeconds + maxClockSkewSeconds
  ) {
    errors.push({
      code: "INVALID_TIMESTAMPS",
      message: "LTI 1.3 iat/exp claims must be valid safe-integer Unix seconds with iat < exp",
    });
  } else if (nowSeconds >= exp + maxClockSkewSeconds) {
    errors.push({
      code: "TOKEN_EXPIRED",
      message: "LTI 1.3 token has expired",
    });
  } else {
    validExp = exp;
    validIat = iat;
  }

  // 7. LTI Version & Message Type
  if (claims[LTI_CLAIM_VERSION] !== LTI_13_VERSION) {
    errors.push({
      code: "INVALID_VERSION",
      message: `LTI version claim must equal "${LTI_13_VERSION}"`,
    });
  }

  const rawMessageType = claims[LTI_CLAIM_MESSAGE_TYPE];
  const validMessageType =
    (rawMessageType === "LtiDeepLinkingRequest" ||
      rawMessageType === "LtiResourceLinkRequest") &&
    allowedMessageTypes.has(rawMessageType)
      ? rawMessageType
      : null;
  if (!validMessageType) {
    errors.push({
      code: "INVALID_MESSAGE_TYPE",
      message: "LTI message_type is unsupported or not permitted by policy",
    });
  }

  // 8. Deep-Linking Settings (mandatory for LtiDeepLinkingRequest)
  let deepLinkReturnUrl: string | null = null;
  if (validMessageType === "LtiDeepLinkingRequest") {
    const settings = claims[LTI_CLAIM_DEEP_LINKING_SETTINGS];
    const parsedReturnUrl = parseHttpsUrl(settings?.deep_link_return_url);
    const acceptsResourceLink =
      Array.isArray(settings?.accept_types) &&
      settings.accept_types.includes("ltiResourceLink");
    const originAllowed =
      parsedReturnUrl !== null &&
      (allowedReturnOrigins === null ||
        allowedReturnOrigins.has(parsedReturnUrl.origin));

    if (!parsedReturnUrl || !acceptsResourceLink || !originAllowed) {
      errors.push({
        code: "INVALID_DEEP_LINKING_SETTINGS",
        message:
          "LtiDeepLinkingRequest requires an allowed https:// deep_link_return_url and accept_types including ltiResourceLink",
      });
    } else {
      deepLinkReturnUrl = parsedReturnUrl.toString();
    }
  }

  // 9. Target cartridge/course resource link validation
  const rawCustom = claims[LTI_CLAIM_CUSTOM];
  const custom: Readonly<Record<string, unknown>> =
    typeof rawCustom === "object" && rawCustom !== null && !Array.isArray(rawCustom)
      ? (rawCustom as Readonly<Record<string, unknown>>)
      : {};
  const resourceLink = claims[LTI_CLAIM_RESOURCE_LINK];

  const customResourceLinkId =
    typeof custom.resource_link_id === "string"
      ? custom.resource_link_id
      : undefined;
  const rawResourceLinkId = resourceLink?.id ?? customResourceLinkId;
  const rawCartridgeId = custom.cartridge_id;
  const rawCourseId = custom.course_id;
  const rawTargetUri =
    resourceLink?.target_link_uri ?? custom.target_link_uri;

  const resourceLinkId = isSafeResourceIdentifier(rawResourceLinkId)
    ? rawResourceLinkId.trim()
    : null;
  const cartridgeId =
    rawCartridgeId === undefined
      ? null
      : typeof rawCartridgeId === "string" &&
          isSafeResourceIdentifier(rawCartridgeId)
        ? rawCartridgeId.trim()
        : "INVALID";
  const courseId =
    rawCourseId === undefined
      ? null
      : typeof rawCourseId === "string" && isSafeResourceIdentifier(rawCourseId)
        ? rawCourseId.trim()
        : "INVALID";

  let targetLinkUri: string | null = null;
  let targetUriValid = true;
  if (rawTargetUri !== undefined) {
    const parsed =
      typeof rawTargetUri === "string" ? parseHttpsUrl(rawTargetUri) : null;
    if (!parsed) {
      targetUriValid = false;
    } else {
      targetLinkUri = parsed.toString();
    }
  }

  const cartridgeIdValid =
    cartridgeId !== "INVALID" &&
    (allowedCartridgeIds === null ||
      (cartridgeId === null
        ? allowedCourseIds !== null && courseId !== null
        : allowedCartridgeIds.has(cartridgeId)));
  const courseIdValid =
    courseId !== "INVALID" &&
    (allowedCourseIds === null ||
      (courseId === null
        ? allowedCartridgeIds !== null && cartridgeId !== null
        : allowedCourseIds.has(courseId)));
  const hasTargetAsset =
    (cartridgeId !== null && cartridgeId !== "INVALID") ||
    (courseId !== null && courseId !== "INVALID");

  if (
    !resourceLinkId ||
    !hasTargetAsset ||
    !targetUriValid ||
    !cartridgeIdValid ||
    !courseIdValid
  ) {
    errors.push({
      code: "INVALID_TARGET_RESOURCE_LINK",
      message:
        "Target cartridge/course resource link must specify a safe resource_link id, allowed cartridge_id or course_id, and https:// target_link_uri if present",
    });
  }

  // 10. Strict IMS LIS Role Mapping (fail-closed)
  const { mappedRole, matchedRoleUris } = mapImsLtiRoles(
    claims[LTI_CLAIM_ROLES],
  );
  if (!mappedRole) {
    errors.push({
      code: "NO_VALID_LTI_ROLE",
      message: "At least one recognized IMS LIS v2 role URI is required",
    });
  }

  // 11. Hard Privacy Boundary Guard against forbidden custom scopes/claims
  for (const [key, value] of Object.entries(custom)) {
    const normalizedKey = key.trim().toLowerCase();
    if (
      FORBIDDEN_PRIVACY_CUSTOM_KEYS.has(normalizedKey) &&
      isForbiddenPrivacyClaimValue(value)
    ) {
      errors.push({
        code: "FORBIDDEN_PRIVACY_SCOPE",
        message: `LTI launch cannot request solo private notes or raw attempt transcripts (forbidden claim "${key}")`,
      });
    }
  }

  if (
    errors.length > 0 ||
    !validMessageType ||
    !mappedRole ||
    !resourceLinkId ||
    validExp === null ||
    validIat === null
  ) {
    return {
      valid: false,
      context: null,
      errors,
    };
  }

  const contextId =
    typeof claims[LTI_CLAIM_CONTEXT]?.id === "string" &&
    claims[LTI_CLAIM_CONTEXT].id.trim().length > 0
      ? claims[LTI_CLAIM_CONTEXT].id.trim()
      : null;

  return {
    valid: true,
    errors: [],
    context: {
      issuer: trimmedIssuer,
      clientId: expectedClientId,
      deploymentId,
      subject,
      nonce,
      messageType: validMessageType,
      expiresAtMs: validExp * 1000,
      issuedAtMs: validIat * 1000,
      contextId,
      targetResourceLink: {
        resourceLinkId,
        cartridgeId: cartridgeId === "INVALID" ? null : cartridgeId,
        courseId: courseId === "INVALID" ? null : courseId,
        targetLinkUri,
      },
      deepLinkReturnUrl,
      mappedRole,
      matchedRoleUris,
      privacyBoundary: {
        canViewAggregatedCohortHeatmap:
          mappedRole === "instructor" || mappedRole === "admin",
        canAccessSoloLearnerPrivateNotes: false,
        canAccessRawAttemptTranscripts: false,
        canQuerySlidingTimeWindows: false,
      },
    },
  };
}
