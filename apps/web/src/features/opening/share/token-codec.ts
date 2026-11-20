import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  SHARE_TOKEN_DEFAULT_TTL_SECONDS,
  SHARE_TOKEN_MAX_LENGTH,
  SHARE_TOKEN_VERSION,
  findForbiddenShareKeys,
  normalizeCohortTrapRate,
  shareMintInputSchema,
  shareTokenPayloadSchema,
  type ShareTokenPayload,
} from "./schema";

export const SHARE_KEY_DERIVATION_CONTEXT = "opening:pitfall-share:v1";
export const SHARE_AUTH_SECRET_MIN_LENGTH = 32;

const HMAC_SHA256_BYTES = 32;
const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/;

export class ShareTokenConfigError extends Error {
  constructor(message = "AUTH_SECRET must be at least 32 characters") {
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
 * Refuses to proceed if AUTH_SECRET is absent or shorter than 32 characters.
 */
export function deriveShareSigningKey(authSecret?: string): Buffer {
  const secret = authSecret ?? process.env.AUTH_SECRET;
  if (
    typeof secret !== "string" ||
    secret.length < SHARE_AUTH_SECRET_MIN_LENGTH ||
    secret.trim().length < SHARE_AUTH_SECRET_MIN_LENGTH
  ) {
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
