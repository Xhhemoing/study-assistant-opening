import { z } from "zod";

export const SHARE_TOKEN_VERSION = 1 as const;
export const SHARE_TOKEN_MAX_LENGTH = 2048;
export const SHARE_TOKEN_MIN_TTL_SECONDS = 60;
export const SHARE_TOKEN_DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60;
export const SHARE_TOKEN_MAX_TTL_SECONDS = 90 * 24 * 60 * 60;
export const SHARE_COHORT_MIN_SAMPLE_SIZE = 30;
export const SHARE_MINT_MAX_BODY_BYTES = 16 * 1024;

export const SUBJECT_LABEL_MAX_LENGTH = 40;
export const PITFALL_TITLE_MAX_LENGTH = 80;
export const TRAP_SUMMARY_MAX_LENGTH = 180;
export const TAKEAWAY_RULE_MAX_LENGTH = 180;

function isDisallowedControlCode(code: number): boolean {
  return (
    (code >= 0x00 && code <= 0x08) ||
    code === 0x0b ||
    code === 0x0c ||
    (code >= 0x0e && code <= 0x1f) ||
    (code >= 0x7f && code <= 0x9f)
  );
}

/**
 * Detect disallowed control characters and XML 1.0 illegal code points:
 * U+FFFE, U+FFFF, and unpaired UTF-16 surrogates (U+D800-U+DFFF).
 * Valid surrogate pairs (U+10000-U+10FFFF) are permitted.
 */
export function hasDisallowedXmlOrControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
      return true;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
    if (isDisallowedControlCode(code) || code === 0xfffe || code === 0xffff) {
      return true;
    }
  }
  return false;
}

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const EMAIL_PATTERN = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const IDENTIFIER_LEAK_PATTERN =
  /\b(?:user_?id|workspace_?id|owner_?user_?id|session_?id|student_?id|email)\s*[:=]/i;
const RAW_GRADE_LEAK_PATTERN =
  /(?:\b(?:raw_?score|exam_?score|final_?score|student_?grade|grade|gpa)\s*[:=]\s*[A-F0-9]|(?:个人成绩|考试成绩|本次得分|卷面分|实得分|学号)\s*[:：]\s*\S)/i;

export const FORBIDDEN_SHARE_KEYS = new Set([
  "userid",
  "user_id",
  "owneruserid",
  "owner_user_id",
  "workspaceid",
  "workspace_id",
  "email",
  "useremail",
  "user_email",
  "sessionid",
  "session_id",
  "studentid",
  "student_id",
  "score",
  "scores",
  "rawscore",
  "raw_score",
  "grade",
  "grades",
  "rawgrade",
  "raw_grade",
  "gpa",
]);

export type SharePrivacyViolation =
  | "control_chars"
  | "uuid"
  | "email"
  | "identifier"
  | "raw_grade";

export function sanitizeShareText(value: string): string {
  return value
    .normalize("NFC")
    .replace(/[\t\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function detectSharePrivacyViolation(value: string): SharePrivacyViolation | null {
  if (hasDisallowedXmlOrControlChars(value)) return "control_chars";
  if (UUID_PATTERN.test(value)) return "uuid";
  if (EMAIL_PATTERN.test(value)) return "email";
  if (IDENTIFIER_LEAK_PATTERN.test(value)) return "identifier";
  if (RAW_GRADE_LEAK_PATTERN.test(value)) return "raw_grade";
  return null;
}

export function findForbiddenShareKeys(value: unknown): string[] {
  const found: string[] = [];
  const visit = (node: unknown, depth: number) => {
    if (depth > 4 || !node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    for (const [key, nested] of Object.entries(node as Record<string, unknown>)) {
      if (FORBIDDEN_SHARE_KEYS.has(key.toLowerCase())) {
        found.push(key);
      }
      visit(nested, depth + 1);
    }
  };
  visit(value, 0);
  return found;
}

/**
 * Cohort rate sample gate (n >= 30):
 * Never expose or fabricate a cohort trap rate when sample size is below 30.
 */
export function normalizeCohortTrapRate(
  cohortSampleSize: number,
  cohortTrapRate: number | null | undefined,
): number | null {
  if (!Number.isInteger(cohortSampleSize) || cohortSampleSize < SHARE_COHORT_MIN_SAMPLE_SIZE) {
    return null;
  }
  if (cohortTrapRate === null || cohortTrapRate === undefined) {
    return null;
  }
  if (typeof cohortTrapRate !== "number" || !Number.isFinite(cohortTrapRate)) {
    return null;
  }
  const rounded = Math.round(cohortTrapRate);
  if (rounded < 0 || rounded > 100) {
    return null;
  }
  return rounded;
}

function safeShareTextSchema(maxLength: number, fieldName: string) {
  return z
    .string()
    .refine((value) => !hasDisallowedXmlOrControlChars(value), {
      message: `${fieldName} contains disallowed control or XML-invalid characters`,
    })
    .transform(sanitizeShareText)
    .refine((value) => value.length >= 1, {
      message: `${fieldName} is required`,
    })
    .refine((value) => value.length <= maxLength, {
      message: `${fieldName} must be at most ${maxLength} characters`,
    })
    .refine((value) => detectSharePrivacyViolation(value) === null, {
      message: `${fieldName} contains restricted personal or identifier text`,
    });
}

/**
 * Strict HTTP request contract for POST /api/opening/share.
 * Clients may ONLY select a server-authoritative pitfallId and optional TTL;
 * arbitrary copy or cohort statistics are rejected to prevent forged badges.
 */
export const shareMintRequestSchema = z
  .object({
    pitfallId: z
      .string()
      .trim()
      .min(1, "pitfallId is required")
      .max(64, "pitfallId must be at most 64 characters")
      .regex(/^[a-z0-9][a-z0-9-]*$/, "pitfallId format is invalid"),
    expiresInSeconds: z
      .number()
      .int()
      .min(SHARE_TOKEN_MIN_TTL_SECONDS)
      .max(SHARE_TOKEN_MAX_TTL_SECONDS)
      .optional(),
  })
  .strict();

export type ShareMintRequest = z.input<typeof shareMintRequestSchema>;
export type ParsedShareMintRequest = z.output<typeof shareMintRequestSchema>;

export const shareMintInputSchema = z
  .object({
    subjectLabel: safeShareTextSchema(SUBJECT_LABEL_MAX_LENGTH, "subjectLabel"),
    pitfallTitle: safeShareTextSchema(PITFALL_TITLE_MAX_LENGTH, "pitfallTitle"),
    trapSummary: safeShareTextSchema(TRAP_SUMMARY_MAX_LENGTH, "trapSummary"),
    takeawayRule: safeShareTextSchema(TAKEAWAY_RULE_MAX_LENGTH, "takeawayRule"),
    cohortSampleSize: z.number().int().min(0).max(10_000_000).default(0),
    cohortTrapRate: z
      .number()
      .finite()
      .min(0)
      .max(100)
      .nullable()
      .optional()
      .default(null),
    ttlSeconds: z
      .number()
      .int()
      .min(SHARE_TOKEN_MIN_TTL_SECONDS)
      .max(SHARE_TOKEN_MAX_TTL_SECONDS)
      .optional(),
  })
  .strict()
  .transform((data) => ({
    ...data,
    cohortTrapRate: normalizeCohortTrapRate(data.cohortSampleSize, data.cohortTrapRate),
  }));

export type ShareMintInput = z.input<typeof shareMintInputSchema>;
export type ParsedShareMintInput = z.output<typeof shareMintInputSchema>;

export const shareTokenPayloadSchema = z
  .object({
    v: z.literal(SHARE_TOKEN_VERSION),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
    subjectLabel: safeShareTextSchema(SUBJECT_LABEL_MAX_LENGTH, "subjectLabel"),
    pitfallTitle: safeShareTextSchema(PITFALL_TITLE_MAX_LENGTH, "pitfallTitle"),
    trapSummary: safeShareTextSchema(TRAP_SUMMARY_MAX_LENGTH, "trapSummary"),
    takeawayRule: safeShareTextSchema(TAKEAWAY_RULE_MAX_LENGTH, "takeawayRule"),
    cohortSampleSize: z.number().int().min(0).max(10_000_000),
    cohortTrapRate: z.number().int().min(0).max(100).nullable(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.exp <= data.iat) {
      ctx.addIssue({
        code: "custom",
        path: ["exp"],
        message: "exp must be greater than iat",
      });
    }
    if (data.exp - data.iat > SHARE_TOKEN_MAX_TTL_SECONDS) {
      ctx.addIssue({
        code: "custom",
        path: ["exp"],
        message: "token TTL exceeds maximum allowed duration",
      });
    }
  })
  .transform((data) => ({
    ...data,
    cohortTrapRate: normalizeCohortTrapRate(data.cohortSampleSize, data.cohortTrapRate),
  }));

export type ShareTokenPayload = z.output<typeof shareTokenPayloadSchema>;

export type ShareCardData = {
  subjectLabel: string;
  pitfallTitle: string;
  trapSummary: string;
  takeawayRule: string;
  cohortSampleSize: number;
  cohortTrapRate: number | null;
};

export function toDisplayShareCard(
  payload: Pick<
    ShareTokenPayload,
    | "subjectLabel"
    | "pitfallTitle"
    | "trapSummary"
    | "takeawayRule"
    | "cohortSampleSize"
    | "cohortTrapRate"
  >,
): ShareCardData {
  return {
    subjectLabel: payload.subjectLabel,
    pitfallTitle: payload.pitfallTitle,
    trapSummary: payload.trapSummary,
    takeawayRule: payload.takeawayRule,
    cohortSampleSize: payload.cohortSampleSize,
    cohortTrapRate: normalizeCohortTrapRate(payload.cohortSampleSize, payload.cohortTrapRate),
  };
}
