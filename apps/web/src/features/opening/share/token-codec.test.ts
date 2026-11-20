import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  SHARE_TOKEN_DEFAULT_TTL_SECONDS,
  SHARE_TOKEN_MAX_LENGTH,
  SHARE_TOKEN_MAX_TTL_SECONDS,
} from "./schema";
import {
  SHARE_KEY_DERIVATION_CONTEXT,
  ShareTokenConfigError,
  ShareTokenValidationError,
  deriveShareSigningKey,
  signPitfallShareToken,
  verifyPitfallShareToken,
} from "./token-codec";

const TEST_SECRET = "opening-share-test-secret-0123456789abcdef";
const OTHER_SECRET = "different-secret-value-for-tamper-0123456789";
const BASE_TIME_MS = Date.UTC(2026, 10, 20, 12, 0, 0);

const VALID_INPUT = {
  subjectLabel: "高等数学",
  pitfallTitle: "洛必达法则别忘先验证 0/0 或 ∞/∞ 型",
  trapSummary: "看到分式极限就直接上下求导，忽略了代入后其实是非未定式，反而把正确答案算错。",
  takeawayRule: "求极限先代入判型，只有 0/0 或 ∞/∞ 才动用洛必达。",
  cohortSampleSize: 48,
  cohortTrapRate: 63.6,
};

function forgeSignedToken(rawPayload: Record<string, unknown>, secret = TEST_SECRET): string {
  const key = deriveShareSigningKey(secret);
  const payloadSegment = Buffer.from(JSON.stringify(rawPayload), "utf8").toString("base64url");
  const sigSegment = createHmac("sha256", key).update(payloadSegment).digest("base64url");
  return `${payloadSegment}.${sigSegment}`;
}

describe("stateless HMAC-SHA256 pitfall share token codec", () => {
  const originalSecret = process.env.AUTH_SECRET;

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.AUTH_SECRET;
    } else {
      process.env.AUTH_SECRET = originalSecret;
    }
  });

  it("derives a domain-separated key and rejects raw-secret signatures", () => {
    const derived = deriveShareSigningKey(TEST_SECRET);
    const expected = createHmac("sha256", TEST_SECRET)
      .update(SHARE_KEY_DERIVATION_CONTEXT)
      .digest();
    expect(derived.equals(expected)).toBe(true);

    const signed = signPitfallShareToken(VALID_INPUT, {
      authSecret: TEST_SECRET,
      nowMs: BASE_TIME_MS,
    });
    const [payloadSegment] = signed.token.split(".");
    const rawSecretSig = createHmac("sha256", TEST_SECRET)
      .update(payloadSegment!)
      .digest("base64url");
    const rawSignedToken = `${payloadSegment}.${rawSecretSig}`;

    expect(
      verifyPitfallShareToken(rawSignedToken, {
        authSecret: TEST_SECRET,
        nowMs: BASE_TIME_MS,
      }),
    ).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("refuses to sign or verify when AUTH_SECRET is missing or shorter than 32 chars", () => {
    delete process.env.AUTH_SECRET;
    expect(() => signPitfallShareToken(VALID_INPUT)).toThrow(ShareTokenConfigError);
    expect(() => signPitfallShareToken(VALID_INPUT, { authSecret: "short-secret-12345" })).toThrow(
      ShareTokenConfigError,
    );
    expect(() =>
      signPitfallShareToken(VALID_INPUT, { authSecret: "   short-even-with-spaces   " }),
    ).toThrow(ShareTokenConfigError);

    const signed = signPitfallShareToken(VALID_INPUT, {
      authSecret: TEST_SECRET,
      nowMs: BASE_TIME_MS,
    });
    expect(verifyPitfallShareToken(signed.token)).toEqual({
      ok: false,
      reason: "misconfigured",
    });
    expect(verifyPitfallShareToken(signed.token, { authSecret: "too-short" })).toEqual({
      ok: false,
      reason: "misconfigured",
    });
  });

  it("signs and verifies a valid token with default 30-day TTL and bounded URL-safe format", () => {
    const signed = signPitfallShareToken(VALID_INPUT, {
      authSecret: TEST_SECRET,
      nowMs: BASE_TIME_MS,
    });

    expect(signed.token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(signed.token.length).toBeLessThanOrEqual(SHARE_TOKEN_MAX_LENGTH);
    expect(signed.sharePath).toBe(`/s/${signed.token}`);
    expect(signed.payload.v).toBe(1);
    expect(signed.payload.iat).toBe(Math.floor(BASE_TIME_MS / 1000));
    expect(signed.payload.exp).toBe(
      Math.floor(BASE_TIME_MS / 1000) + SHARE_TOKEN_DEFAULT_TTL_SECONDS,
    );
    expect(signed.payload.cohortSampleSize).toBe(48);
    expect(signed.payload.cohortTrapRate).toBe(64);
    expect(signed.expiresAt).toBe(new Date(signed.payload.exp * 1000).toISOString());

    const verified = verifyPitfallShareToken(signed.token, {
      authSecret: TEST_SECRET,
      nowMs: BASE_TIME_MS + 60_000,
    });
    expect(verified).toEqual({ ok: true, payload: signed.payload });
  });

  it("enforces max 90-day TTL and rejects expired tokens", () => {
    expect(() =>
      signPitfallShareToken(
        { ...VALID_INPUT, ttlSeconds: SHARE_TOKEN_MAX_TTL_SECONDS + 1 },
        { authSecret: TEST_SECRET, nowMs: BASE_TIME_MS },
      ),
    ).toThrow(ShareTokenValidationError);

    const signed = signPitfallShareToken(
      { ...VALID_INPUT, ttlSeconds: 3600 },
      { authSecret: TEST_SECRET, nowMs: BASE_TIME_MS },
    );

    expect(
      verifyPitfallShareToken(signed.token, {
        authSecret: TEST_SECRET,
        nowMs: BASE_TIME_MS + 3599 * 1000,
      }).ok,
    ).toBe(true);

    expect(
      verifyPitfallShareToken(signed.token, {
        authSecret: TEST_SECRET,
        nowMs: BASE_TIME_MS + 3600 * 1000,
      }),
    ).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects tampered payload, tampered signature, wrong secret, malformed, and oversized tokens", () => {
    const signed = signPitfallShareToken(VALID_INPUT, {
      authSecret: TEST_SECRET,
      nowMs: BASE_TIME_MS,
    });
    const [payloadSeg, sigSeg] = signed.token.split(".") as [string, string];

    // Flip a character in the signature
    const flippedSig = `${sigSeg[0] === "A" ? "B" : "A"}${sigSeg.slice(1)}`;
    expect(
      verifyPitfallShareToken(`${payloadSeg}.${flippedSig}`, {
        authSecret: TEST_SECRET,
        nowMs: BASE_TIME_MS,
      }),
    ).toEqual({ ok: false, reason: "invalid_signature" });

    // Flip a character in the payload
    const flippedPayload = `${payloadSeg[0] === "e" ? "f" : "e"}${payloadSeg.slice(1)}`;
    expect(
      verifyPitfallShareToken(`${flippedPayload}.${sigSeg}`, {
        authSecret: TEST_SECRET,
        nowMs: BASE_TIME_MS,
      }),
    ).toEqual({ ok: false, reason: "invalid_signature" });

    // Wrong secret
    expect(
      verifyPitfallShareToken(signed.token, {
        authSecret: OTHER_SECRET,
        nowMs: BASE_TIME_MS,
      }),
    ).toEqual({ ok: false, reason: "invalid_signature" });

    // Single-bit flip in the decoded 32-byte digest (exercises fixed-length timingSafeEqual)
    const rawSigBytes = Buffer.from(sigSeg, "base64url");
    expect(rawSigBytes.byteLength).toBe(32);
    rawSigBytes[31] = rawSigBytes[31]! ^ 0x01;
    expect(
      verifyPitfallShareToken(`${payloadSeg}.${rawSigBytes.toString("base64url")}`, {
        authSecret: TEST_SECRET,
        nowMs: BASE_TIME_MS,
      }),
    ).toEqual({ ok: false, reason: "invalid_signature" });

    // 31-byte and 33-byte signatures (must reject cleanly without RangeError)
    const sig31 = Buffer.alloc(31, 0x42).toString("base64url");
    const sig33 = Buffer.alloc(33, 0x42).toString("base64url");
    expect(
      verifyPitfallShareToken(`${payloadSeg}.${sig31}`, {
        authSecret: TEST_SECRET,
        nowMs: BASE_TIME_MS,
      }),
    ).toEqual({ ok: false, reason: "invalid_signature" });
    expect(
      verifyPitfallShareToken(`${payloadSeg}.${sig33}`, {
        authSecret: TEST_SECRET,
        nowMs: BASE_TIME_MS,
      }),
    ).toEqual({ ok: false, reason: "invalid_signature" });

    // Non-canonical base64url trailing bits on a 32-byte signature (43rd char has 2 low padding bits)
    const lastChar = sigSeg[sigSeg.length - 1]!;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const nonCanonicalChar = alphabet[(alphabet.indexOf(lastChar) ^ 1) % 64]!;
    const nonCanonicalSig = `${sigSeg.slice(0, -1)}${nonCanonicalChar}`;
    expect(
      verifyPitfallShareToken(`${payloadSeg}.${nonCanonicalSig}`, {
        authSecret: TEST_SECRET,
        nowMs: BASE_TIME_MS,
      }),
    ).toEqual({ ok: false, reason: "invalid_signature" });

    // Truncated signature
    expect(
      verifyPitfallShareToken(`${payloadSeg}.${sigSeg.slice(0, 16)}`, {
        authSecret: TEST_SECRET,
        nowMs: BASE_TIME_MS,
      }),
    ).toEqual({ ok: false, reason: "invalid_signature" });

    // Malformed shapes
    expect(
      verifyPitfallShareToken("not-a-valid-token", { authSecret: TEST_SECRET }),
    ).toEqual({ ok: false, reason: "malformed" });
    expect(
      verifyPitfallShareToken(`${payloadSeg}.${sigSeg}.extra`, { authSecret: TEST_SECRET }),
    ).toEqual({ ok: false, reason: "malformed" });

    // Oversized token > 2048 chars
    expect(
      verifyPitfallShareToken(`${"a".repeat(SHARE_TOKEN_MAX_LENGTH)}.${sigSeg}`, {
        authSecret: TEST_SECRET,
      }),
    ).toEqual({ ok: false, reason: "oversized" });
  });

  it("enforces hard privacy gates against forbidden keys and PII/UUIDs in text", () => {
    // Forbidden extra fields rejected on mint
    for (const extra of [
      { userId: "u-1" },
      { workspaceId: "w-1" },
      { email: "student@example.edu" },
      { score: 92 },
      { grade: "A-" },
      { unexpectedKey: "nope" },
    ]) {
      expect(() =>
        signPitfallShareToken(
          { ...VALID_INPUT, ...extra },
          { authSecret: TEST_SECRET, nowMs: BASE_TIME_MS },
        ),
      ).toThrow(ShareTokenValidationError);
    }

    // Embedded UUID, email, identifier, and raw personal score rejected in text
    for (const leakedText of [
      "题目来源 550e8400-e29b-41d4-a716-446655440000 易错点",
      "联系 alice.chen@university.edu 获取讲义",
      "userId: 12345 的错题",
      "本次得分：72分，注意审题",
      "grade=B+ 容易错",
    ]) {
      expect(() =>
        signPitfallShareToken(
          { ...VALID_INPUT, trapSummary: leakedText },
          { authSecret: TEST_SECRET, nowMs: BASE_TIME_MS },
        ),
      ).toThrow(ShareTokenValidationError);
    }

    // Even a validly-signed forged token carrying userId or UUID is rejected on verify
    const forgedWithUserId = forgeSignedToken({
      v: 1,
      iat: Math.floor(BASE_TIME_MS / 1000),
      exp: Math.floor(BASE_TIME_MS / 1000) + 3600,
      subjectLabel: "线性代数",
      pitfallTitle: "矩阵乘法不满足交换律",
      trapSummary: "AB 通常不等于 BA。",
      takeawayRule: "左乘与右乘必须分开写。",
      cohortSampleSize: 40,
      cohortTrapRate: 50,
      userId: "leaked-user",
    });
    expect(
      verifyPitfallShareToken(forgedWithUserId, {
        authSecret: TEST_SECRET,
        nowMs: BASE_TIME_MS,
      }),
    ).toEqual({ ok: false, reason: "invalid_payload" });
  });

  it("enforces cohort sample-size gate (n >= 30) on both minting and decoding", () => {
    const smallCohort = signPitfallShareToken(
      { ...VALID_INPUT, cohortSampleSize: 29, cohortTrapRate: 78 },
      { authSecret: TEST_SECRET, nowMs: BASE_TIME_MS },
    );
    expect(smallCohort.payload.cohortSampleSize).toBe(29);
    expect(smallCohort.payload.cohortTrapRate).toBeNull();

    const thresholdCohort = signPitfallShareToken(
      { ...VALID_INPUT, cohortSampleSize: 30, cohortTrapRate: 78.4 },
      { authSecret: TEST_SECRET, nowMs: BASE_TIME_MS },
    );
    expect(thresholdCohort.payload.cohortSampleSize).toBe(30);
    expect(thresholdCohort.payload.cohortTrapRate).toBe(78);

    // Even if a validly-signed token embeds a non-null rate with n < 30, decode forces null
    const forgedSmallCohort = forgeSignedToken({
      v: 1,
      iat: Math.floor(BASE_TIME_MS / 1000),
      exp: Math.floor(BASE_TIME_MS / 1000) + 3600,
      subjectLabel: "概率论",
      pitfallTitle: "独立与互斥不能混为一谈",
      trapSummary: "把 P(AB)=0 误当成独立事件。",
      takeawayRule: "互斥看交集为空，独立看乘积公式。",
      cohortSampleSize: 12,
      cohortTrapRate: 75,
    });
    const decoded = verifyPitfallShareToken(forgedSmallCohort, {
      authSecret: TEST_SECRET,
      nowMs: BASE_TIME_MS,
    });
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.payload.cohortSampleSize).toBe(12);
      expect(decoded.payload.cohortTrapRate).toBeNull();
    }
  });
});
