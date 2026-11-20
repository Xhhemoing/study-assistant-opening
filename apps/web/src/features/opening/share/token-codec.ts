import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { getShareablePitfallById } from "@aistudy/domain";
import {
  SHARE_TOKEN_DEFAULT_TTL_SECONDS,
  SHARE_TOKEN_MAX_LENGTH,
  SHARE_TOKEN_VERSION,
  findForbiddenShareKeys,
  normalizeCohortTrapRate,
  shareMintInputSchema,
  shareMintRequestSchema,
  shareTokenPayloadSchema,
  type ShareTokenPayload,
} from "./schema";

export const SHARE_KEY_DERIVATION_CONTEXT = "opening:pitfall-share:v1";
export const SHARE_AUTH_SECRET_MIN_LENGTH = 32;
export const SHARE_AUTH_SECRET_MIN_UNIQUE_CHARS = 8;

const HMAC_SHA256_BYTES = 32;
const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/;
const PLACEHOLDER_SECRET_PATTERN =
  /(?:change[-_ ]?me|replace[-_ ]?with|your[-_ ]?secret|example|placeholder|default[-_ ]?secret|dummy[-_ ]?secret|insert[-_ ]?secret)/i;

export class ShareTokenConfigError extends Error {
  constructor(
    message = "AUTH_SECRET must be a non-placeholder high-entropy secret of at least 32 characters",
  ) {
    super(message);
    this.name = "ShareTokenConfigError";
  }
}

export class ShareTokenValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShareTokenValidationError";
  }
}

export class SharePitfallNotFoundError extends Error {
  constructor(pitfallId: string) {
    super(`Unknown pitfallId: ${pitfallId}`);
    this.name = "SharePitfallNotFoundError";
  }
}

export type ShareCodecOptions = {
  authSecret?: string;
  nowMs?: number;
};

export type SignedShareToken = {
  token: string;
  sharePath: string;
  expiresAt: string;
  payload: ShareTokenPayload;
};

export type AuthoritativeSignedShareToken = SignedShareToken & {
  pitfallId: string;
};

export type VerifyShareTokenFailureReason =
  | "misconfigured"
  | "malformed"
  | "oversized"
  | "invalid_signature"
  | "expired"
  | "invalid_payload";

export type VerifyShareTokenResult =
  | { ok: true; payload: ShareTokenPayload }
  | { ok: false; reason: VerifyShareTokenFailureReason };

/**
 * Derive a domain-separated 256-bit HMAC signing key from AUTH_SECRET.
 * Refuses to proceed if AUTH_SECRET is absent, shorter than 32 characters,
 * low-entropy (< 8 distinct characters), or matches common example placeholders.
 */
export function deriveShareSigningKey(authSecret?: string): Buffer {
  const secret = authSecret ?? process.env.AUTH_SECRET;
  if (typeof secret !== "string") {
    throw new ShareTokenConfigError();
  }
  const trimmed = secret.trim();
  if (
    secret.length < SHARE_AUTH_SECRET_MIN_LENGTH ||
    trimmed.length < SHARE_AUTH_SECRET_MIN_LENGTH
  ) {
    throw new ShareTokenConfigError();
  }
  if (new Set([...trimmed]).size < SHARE_AUTH_SECRET_MIN_UNIQUE_CHARS) {
    throw new ShareTokenConfigError();
  }
  if (PLACEHOLDER_SECRET_PATTERN.test(trimmed)) {
    throw new ShareTokenConfigError();
  }
  return createHmac("sha256", secret)
    .update(SHARE_KEY_DERIVATION_CONTEXT)
    .digest();
}

function decodeCanonicalBase64Url(segment: string): Buffer | null {
  if (!segment || !BASE64URL_SEGMENT.test(segment)) {
    return null;
  }
  const decoded = Buffer.from(segment, "base64url");
  if (decoded.byteLength === 0 || decoded.toString("base64url") !== segment) {
    return null;
  }
  return decoded;
}

export function signPitfallShareToken(
  input: unknown,
  options: ShareCodecOptions = {},
): SignedShareToken {
  const key = deriveShareSigningKey(options.authSecret);

  const forbidden = findForbiddenShareKeys(input);
  if (forbidden.length > 0) {
    throw new ShareTokenValidationError("Payload contains restricted privacy fields");
  }

  const parsed = shareMintInputSchema.safeParse(input);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    throw new ShareTokenValidationError(firstIssue?.message ?? "Invalid share payload");
  }

  const nowSec = Math.floor((options.nowMs ?? Date.now()) / 1000);
  const ttlSeconds = parsed.data.ttlSeconds ?? SHARE_TOKEN_DEFAULT_TTL_SECONDS;
  const exp = nowSec + ttlSeconds;

  const payload = shareTokenPayloadSchema.parse({
    v: SHARE_TOKEN_VERSION,
    iat: nowSec,
    exp,
    subjectLabel: parsed.data.subjectLabel,
    pitfallTitle: parsed.data.pitfallTitle,
    trapSummary: parsed.data.trapSummary,
    takeawayRule: parsed.data.takeawayRule,
    cohortSampleSize: parsed.data.cohortSampleSize,
    cohortTrapRate: normalizeCohortTrapRate(
      parsed.data.cohortSampleSize,
      parsed.data.cohortTrapRate,
    ),
  });

  const payloadSegment = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sigSegment = createHmac("sha256", key).update(payloadSegment).digest("base64url");
  const token = `${payloadSegment}.${sigSegment}`;

  if (token.length > SHARE_TOKEN_MAX_LENGTH) {
    throw new ShareTokenValidationError("Signed share token exceeds maximum length");
  }

  return {
    token,
    sharePath: `/s/${token}`,
    expiresAt: new Date(payload.exp * 1000).toISOString(),
    payload,
  };
}

/**
 * Server-authoritative share minting from the verified domain catalog.
 * Accepts ONLY `{ pitfallId, expiresInSeconds? }` and ignores/rejects any
 * client-supplied copy or cohort statistics.
 */
export function mintPitfallShareTokenById(
  requestInput: unknown,
  options: ShareCodecOptions = {},
): AuthoritativeSignedShareToken {
  const forbidden = findForbiddenShareKeys(requestInput);
  if (forbidden.length > 0) {
    throw new ShareTokenValidationError("Payload contains restricted privacy fields");
  }

  const parsed = shareMintRequestSchema.safeParse(requestInput);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    throw new ShareTokenValidationError(firstIssue?.message ?? "Invalid share mint request");
  }

  const entry = getShareablePitfallById(parsed.data.pitfallId);
  if (!entry) {
    throw new SharePitfallNotFoundError(parsed.data.pitfallId);
  }

  const signed = signPitfallShareToken(
    {
      subjectLabel: entry.subjectLabel,
      pitfallTitle: entry.pitfallTitle,
      trapSummary: entry.trapSummary,
      takeawayRule: entry.takeawayRule,
      cohortSampleSize: entry.cohortSampleSize,
      cohortTrapRate: entry.cohortTrapRate,
      ...(parsed.data.expiresInSeconds !== undefined
        ? { ttlSeconds: parsed.data.expiresInSeconds }
        : {}),
    },
    options,
  );

  return {
    pitfallId: entry.pitfallId,
    ...signed,
  };
}

export function verifyPitfallShareToken(
  token: unknown,
  options: ShareCodecOptions = {},
): VerifyShareTokenResult {
  if (typeof token !== "string" || token.length === 0) {
    return { ok: false, reason: "malformed" };
  }
  if (token.length > SHARE_TOKEN_MAX_LENGTH) {
    return { ok: false, reason: "oversized" };
  }

  let key: Buffer;
  try {
    key = deriveShareSigningKey(options.authSecret);
  } catch {
    return { ok: false, reason: "misconfigured" };
  }

  const parts = token.split(".");
  if (parts.length !== 2) {
    return { ok: false, reason: "malformed" };
  }
  const [payloadSegment, sigSegment] = parts as [string, string];

  const providedSig = decodeCanonicalBase64Url(sigSegment);
  if (!providedSig || providedSig.byteLength !== HMAC_SHA256_BYTES) {
    return { ok: false, reason: "invalid_signature" };
  }
  if (!payloadSegment || !BASE64URL_SEGMENT.test(payloadSegment)) {
    return { ok: false, reason: "malformed" };
  }

  const expectedSig = createHmac("sha256", key).update(payloadSegment).digest();
  if (
    expectedSig.byteLength !== HMAC_SHA256_BYTES ||
    !timingSafeEqual(expectedSig, providedSig)
  ) {
    return { ok: false, reason: "invalid_signature" };
  }

  const payloadBytes = decodeCanonicalBase64Url(payloadSegment);
  if (!payloadBytes) {
    return { ok: false, reason: "malformed" };
  }

  let rawJson: unknown;
  try {
    rawJson = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    return { ok: false, reason: "invalid_payload" };
  }

  if (findForbiddenShareKeys(rawJson).length > 0) {
    return { ok: false, reason: "invalid_payload" };
  }

  const parsed = shareTokenPayloadSchema.safeParse(rawJson);
  if (!parsed.success) {
    return { ok: false, reason: "invalid_payload" };
  }

  const nowSec = Math.floor((options.nowMs ?? Date.now()) / 1000);
  if (parsed.data.exp <= nowSec) {
    return { ok: false, reason: "expired" };
  }

  // Defense in depth: re-enforce cohort sample gate on decode.
  const payload: ShareTokenPayload = {
    ...parsed.data,
    cohortTrapRate: normalizeCohortTrapRate(
      parsed.data.cohortSampleSize,
      parsed.data.cohortTrapRate,
    ),
  };

  return { ok: true, payload };
}
