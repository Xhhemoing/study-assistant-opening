import { createHmac } from "node:crypto";
import { SHAREABLE_PITFALL_CATALOG } from "@aistudy/domain";
import { afterEach, describe, expect, it } from "vitest";
import {
  SHARE_TOKEN_DEFAULT_TTL_SECONDS,
  SHARE_TOKEN_MAX_LENGTH,
  SHARE_TOKEN_MAX_TTL_SECONDS,
} from "./schema";
import {
  SHARE_KEY_DERIVATION_CONTEXT,
  SharePitfallNotFoundError,
  ShareTokenConfigError,
  ShareTokenValidationError,
  deriveShareSigningKey,
  mintPitfallShareTokenById,
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

  it("refuses to sign or verify when AUTH_SECRET is missing, short, low-entropy, or a placeholder", () => {
    delete process.env.AUTH_SECRET;
    expect(() => signPitfallShareToken(VALID_INPUT)).toThrow(ShareTokenConfigError);

    const signed = signPitfallShareToken(VALID_INPUT, {
      authSecret: TEST_SECRET,
      nowMs: BASE_TIME_MS,
    });
    expect(verifyPitfallShareToken(signed.token)).toEqual({
      ok: false,
      reason: "misconfigured",
    });

    const weakOrPlaceholderSecrets = [
      "short-secret-12345",
      "   short-even-with-spaces   ",
      "a".repeat(32),
      "ab".repeat(20),
      "1234567".repeat(5),
      "REPLACE_ME_auth_secret_long_random",
      "replace-me-auth-secret-long-random",
      "changeme-auth-secret-0123456789abc",
      "change-me-0123456789abcdefghijkl",
      "CHANGE_ME_PRODUCTION_SECRET_0123456",
      "please-replace-with-real-key-012345",
      "your-secret-key-0123456789abcdefgh",
      "YOUR_SECRET_VALUE_0123456789ABCDEF",
      "example-signing-key-0123456789abcd",
      "placeholder-auth-key-0123456789abc",
      "default-secret-value-0123456789abc",
    ];

    for (const badSecret of weakOrPlaceholderSecrets) {
      expect(() =>
        signPitfallShareToken(VALID_INPUT, { authSecret: badSecret, nowMs: BASE_TIME_MS }),
      ).toThrow(ShareTokenConfigError);
      expect(
        verifyPitfallShareToken(signed.token, { authSecret: badSecret, nowMs: BASE_TIME_MS }),
      ).toEqual({ ok: false, reason: "misconfigured" });
    }
  });

  it("explicitly rejects the Docker env template placeholder REPLACE_ME_auth_secret_long_random", () => {
    const dockerTemplateSecret = "REPLACE_ME_auth_secret_long_random";
    expect(() => deriveShareSigningKey(dockerTemplateSecret)).toThrow(ShareTokenConfigError);
    expect(() =>
      signPitfallShareToken(VALID_INPUT, {
        authSecret: dockerTemplateSecret,
        nowMs: BASE_TIME_MS,
      }),
    ).toThrow(ShareTokenConfigError);

    const signed = signPitfallShareToken(VALID_INPUT, {
      authSecret: TEST_SECRET,
      nowMs: BASE_TIME_MS,
    });
    expect(
      verifyPitfallShareToken(signed.token, {
        authSecret: dockerTemplateSecret,
        nowMs: BASE_TIME_MS,
      }),
    ).toEqual({ ok: false, reason: "misconfigured" });
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

    const flippedSig = `${sigSeg[0] === "A" ? "B" : "A"}${sigSeg.slice(1)}`;
    expect(
      verifyPitfallShareToken(`${payloadSeg}.${flippedSig}`, {
        authSecret: TEST_SECRET,
        nowMs: BASE_TIME_MS,
      }),
    ).toEqual({ ok: false, reason: "invalid_signature" });

    const flippedPayload = `${payloadSeg[0] === "e" ? "f" : "e"}${payloadSeg.slice(1)}`;
    expect(
      verifyPitfallShareToken(`${flippedPayload}.${sigSeg}`, {
        authSecret: TEST_SECRET,
        nowMs: BASE_TIME_MS,
      }),
    ).toEqual({ ok: false, reason: "invalid_signature" });

    expect(
      verifyPitfallShareToken(signed.token, {
        authSecret: OTHER_SECRET,
        nowMs: BASE_TIME_MS,
      }),
    ).toEqual({ ok: false, reason: "invalid_signature" });

    const rawSigBytes = Buffer.from(sigSeg, "base64url");
    expect(rawSigBytes.byteLength).toBe(32);
    rawSigBytes[31] = rawSigBytes[31]! ^ 0x01;
    expect(
      verifyPitfallShareToken(`${payloadSeg}.${rawSigBytes.toString("base64url")}`, {
        authSecret: TEST_SECRET,
        nowMs: BASE_TIME_MS,
      }),
    ).toEqual({ ok: false, reason: "invalid_signature" });

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

    expect(
      verifyPitfallShareToken(`${payloadSeg}.${sigSeg.slice(0, 16)}`, {
        authSecret: TEST_SECRET,
        nowMs: BASE_TIME_MS,
      }),
    ).toEqual({ ok: false, reason: "invalid_signature" });

    expect(
      verifyPitfallShareToken("not-a-valid-token", { authSecret: TEST_SECRET }),
    ).toEqual({ ok: false, reason: "malformed" });
    expect(
      verifyPitfallShareToken(`${payloadSeg}.${sigSeg}.extra`, { authSecret: TEST_SECRET }),
    ).toEqual({ ok: false, reason: "malformed" });

    expect(
      verifyPitfallShareToken(`${"a".repeat(SHARE_TOKEN_MAX_LENGTH)}.${sigSeg}`, {
        authSecret: TEST_SECRET,
      }),
    ).toEqual({ ok: false, reason: "oversized" });
  });

  it("enforces hard privacy gates against forbidden keys, PII/UUIDs, and XML 1.0 illegal code points", () => {
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

    for (const leakedText of [
      "题目来源 550e8400-e29b-41d4-a716-446655440000 易错点",
      "联系 alice.chen@university.edu 获取讲义",
      "userId: 12345 的错题",
      "本次得分：72分，注意审题",
      "grade=B+ 容易错",
      "包含非法码点 \uFFFE 字符",
      "包含非法码点 \uFFFF 字符",
      `孤立高代理项 ${String.fromCharCode(0xd800)} 测试`,
      `孤立低代理项 ${String.fromCharCode(0xdc00)} 测试`,
    ]) {
      expect(() =>
        signPitfallShareToken(
          { ...VALID_INPUT, trapSummary: leakedText },
          { authSecret: TEST_SECRET, nowMs: BASE_TIME_MS },
        ),
      ).toThrow(ShareTokenValidationError);
    }

    // Valid surrogate pair (U+20BB7 𠮷) is permitted
    const withValidSurrogatePair = signPitfallShareToken(
      { ...VALID_INPUT, pitfallTitle: "注意辨析特殊字形 𠮷 与常见误区" },
      { authSecret: TEST_SECRET, nowMs: BASE_TIME_MS },
    );
    expect(
      verifyPitfallShareToken(withValidSurrogatePair.token, {
        authSecret: TEST_SECRET,
        nowMs: BASE_TIME_MS,
      }).ok,
    ).toBe(true);

    // Forged signed token containing U+FFFF or userId is rejected on decode
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

    const forgedWithXmlIllegal = forgeSignedToken({
      v: 1,
      iat: Math.floor(BASE_TIME_MS / 1000),
      exp: Math.floor(BASE_TIME_MS / 1000) + 3600,
      subjectLabel: "线性代数",
      pitfallTitle: "非法\uFFFF字符",
      trapSummary: "AB 通常不等于 BA。",
      takeawayRule: "左乘与右乘必须分开写。",
      cohortSampleSize: 40,
      cohortTrapRate: 50,
    });
    expect(
      verifyPitfallShareToken(forgedWithXmlIllegal, {
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

  it("mints tokens exclusively from the server-authoritative catalog and blocks forged fields", () => {
    for (const entry of SHAREABLE_PITFALL_CATALOG) {
      const minted = mintPitfallShareTokenById(
        { pitfallId: entry.pitfallId, expiresInSeconds: 7200 },
        { authSecret: TEST_SECRET, nowMs: BASE_TIME_MS },
      );
      expect(minted.pitfallId).toBe(entry.pitfallId);
      const verified = verifyPitfallShareToken(minted.token, {
        authSecret: TEST_SECRET,
        nowMs: BASE_TIME_MS,
      });
      expect(verified.ok).toBe(true);
      if (verified.ok) {
        expect(verified.payload.subjectLabel).toBe(entry.subjectLabel);
        expect(verified.payload.pitfallTitle).toBe(entry.pitfallTitle);
        expect(verified.payload.trapSummary).toBe(entry.trapSummary);
        expect(verified.payload.takeawayRule).toBe(entry.takeawayRule);
        expect(verified.payload.cohortSampleSize).toBe(0);
        expect(verified.payload.cohortTrapRate).toBeNull();
        expect(verified.payload.exp - verified.payload.iat).toBe(7200);
      }
    }

    expect(() =>
      mintPitfallShareTokenById(
        { pitfallId: "does-not-exist-in-catalog" },
        { authSecret: TEST_SECRET, nowMs: BASE_TIME_MS },
      ),
    ).toThrow(SharePitfallNotFoundError);

    for (const forgedOverride of [
      { pitfallId: "math-calculus-lhopital-form", title: "钓鱼标题" },
      { pitfallId: "math-calculus-lhopital-form", misconception: "伪造错因" },
      { pitfallId: "math-calculus-lhopital-form", reframe: "伪造口诀" },
      { pitfallId: "math-calculus-lhopital-form", ctaHref: "https://evil.example" },
      { pitfallId: "math-calculus-lhopital-form", pitfallTitle: "覆盖标题" },
      { pitfallId: "math-calculus-lhopital-form", cohortSampleSize: 9999 },
      { pitfallId: "math-calculus-lhopital-form", cohortTrapRate: 99 },
    ]) {
      expect(() =>
        mintPitfallShareTokenById(forgedOverride, {
          authSecret: TEST_SECRET,
          nowMs: BASE_TIME_MS,
        }),
      ).toThrow(ShareTokenValidationError);
    }
  });
});
