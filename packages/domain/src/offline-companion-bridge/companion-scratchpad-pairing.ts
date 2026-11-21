import {
  COMPANION_ALLOWED_ACTIONS,
  COMPANION_COOKIE_PATH,
  COMPANION_PAIRING_TTL_MS,
  COMPANION_USER_CODE_ALPHABET,
  type AppendCompanionScratchpadPageInput,
  type AppendCompanionScratchpadPageResult,
  type AuthorizeCompanionActionInput,
  type AuthorizeCompanionActionResult,
  type CompanionAllowedAction,
  type CompanionPairingOffer,
  type CompanionScratchpadPage,
  type CompanionScratchpadState,
  type CompanionSession,
  type CreateCompanionPairingOfferInput,
  type CreateCompanionPairingOfferResult,
  type FreezeCompanionScratchpadInput,
  type FreezeCompanionScratchpadResult,
  type RedeemCompanionPairingOfferInput,
  type RedeemCompanionPairingOfferResult,
} from "./types";

const DEFAULT_COMPANION_PAIRING_PATH = "/companion/pair";
const DEFAULT_COMPANION_SESSION_TTL_MS = 2 * 3_600_000; // 2 hours
const MAX_COMPANION_SESSION_TTL_MS = 12 * 3_600_000; // 12 hours
const MIN_SECRET_LENGTH = 16;
const USER_CODE_LENGTH = 8;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/i;

const ALLOWED_ACTION_SET: ReadonlySet<string> = new Set<string>(COMPANION_ALLOWED_ACTIONS);
const USER_CODE_CHAR_SET: ReadonlySet<string> = new Set(COMPANION_USER_CODE_ALPHABET.split(""));

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

const SHA256_H0: readonly [number, number, number, number, number, number, number, number] = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

function sha256Utf8Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLen = bytes.length * 8;
  const paddedLen = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x1_0000_0000), false);
  view.setUint32(paddedLen - 4, bitLen >>> 0, false);

  let state0: number = SHA256_H0[0];
  let state1: number = SHA256_H0[1];
  let state2: number = SHA256_H0[2];
  let state3: number = SHA256_H0[3];
  let state4: number = SHA256_H0[4];
  let state5: number = SHA256_H0[5];
  let state6: number = SHA256_H0[6];
  let state7: number = SHA256_H0[7];
  const w = new Uint32Array(64);
  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i += 1) {
      const w15 = w[i - 15] ?? 0;
      const w2 = w[i - 2] ?? 0;
      const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
      const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
      w[i] = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) >>> 0;
    }
    let a = state0;
    let b = state1;
    let c = state2;
    let d = state3;
    let e = state4;
    let f = state5;
    let g = state6;
    let h = state7;
    for (let i = 0; i < 64; i += 1) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + (SHA256_K[i] ?? 0) + (w[i] ?? 0)) >>> 0;
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    state0 = (state0 + a) >>> 0;
    state1 = (state1 + b) >>> 0;
    state2 = (state2 + c) >>> 0;
    state3 = (state3 + d) >>> 0;
    state4 = (state4 + e) >>> 0;
    state5 = (state5 + f) >>> 0;
    state6 = (state6 + g) >>> 0;
    state7 = (state7 + h) >>> 0;
  }
  return [state0, state1, state2, state3, state4, state5, state6, state7]
    .map(value => value.toString(16).padStart(8, "0"))
    .join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  const maxLen = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < maxLen; i += 1) {
    const a = i < left.length ? left.charCodeAt(i) : 0;
    const b = i < right.length ? right.charCodeAt(i) : 0;
    diff |= a ^ b;
  }
  return diff === 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isAllowedCompanionAction(action: string): action is CompanionAllowedAction {
  return ALLOWED_ACTION_SET.has(action);
}

/**
 * Normalizes an HTTPS origin string (`https://host[:non-default-port]`) and rejects
 * non-HTTPS schemes, credentials, non-root paths, query strings, or fragments.
 */
export function normalizeOrigin(rawOrigin: string): string | null {
  if (!isNonEmptyString(rawOrigin)) return null;
  const trimmed = rawOrigin.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") return null;
  if (!parsed.origin || parsed.origin === "null") return null;
  return parsed.origin.toLowerCase();
}

const MULTI_PART_PUBLIC_SUFFIXES: ReadonlySet<string> = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "net.uk", "sch.uk", "nhs.uk", "police.uk",
  "com.cn", "edu.cn", "gov.cn", "org.cn", "net.cn", "ac.cn",
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "asn.au", "id.au",
  "co.jp", "or.jp", "ne.jp", "ac.jp", "go.jp", "ed.jp", "gr.jp", "lg.jp",
  "com.hk", "edu.hk", "gov.hk", "org.hk", "net.hk",
  "com.tw", "edu.tw", "gov.tw", "org.tw", "net.tw",
  "com.sg", "edu.sg", "gov.sg", "org.sg", "net.sg",
  "co.kr", "or.kr", "ac.kr", "go.kr", "re.kr",
  "co.in", "org.in", "ac.in", "gov.in", "net.in", "edu.in",
  "com.br", "org.br", "gov.br", "edu.br", "net.br",
  "co.nz", "org.nz", "ac.nz", "govt.nz", "net.nz",
  "co.za", "org.za", "ac.za", "gov.za",
  "com.mx", "org.mx", "edu.mx", "gob.mx",
  "com.tr", "org.tr", "edu.tr", "gov.tr",
  "com.my", "edu.my", "gov.my", "org.my",
  "co.id", "ac.id", "go.id", "or.id",
  "co.il", "ac.il", "gov.il", "org.il",
  "com.ar", "org.ar", "edu.ar", "gov.ar",
  "com.pl", "net.pl", "org.pl", "edu.pl", "gov.pl",
  "com.ua", "org.ua", "edu.ua", "gov.ua",
  "gc.ca", "gov.ca",
]);

const IPV4_LITERAL_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const DNS_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

function normalizeHostname(origin: string): string {
  return new URL(origin).hostname.toLowerCase().replace(/\.$/, "");
}

/**
 * Extracts the RFC 6265 / Fetch registrable site (eTLD+1) from a normalized HTTPS origin.
 * Returns `null` for IP literals, `localhost`/`*.localhost`, single-label hosts, or bare public suffixes.
 */
export function extractRegistrableSite(rawOrigin: string): string | null {
  const normalizedOrigin = normalizeOrigin(rawOrigin);
  if (!normalizedOrigin) return null;
  const host = normalizeHostname(normalizedOrigin);
  if (
    !host ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.includes(":") ||
    host.startsWith("[") ||
    IPV4_LITERAL_RE.test(host)
  ) {
    return null;
  }
  const labels = host.split(".");
  if (labels.length < 2 || labels.some(label => !DNS_LABEL_RE.test(label))) {
    return null;
  }
  const lastTwo = `${labels[labels.length - 2]}.${labels[labels.length - 1]}`;
  if (MULTI_PART_PUBLIC_SUFFIXES.has(lastTwo)) {
    if (labels.length < 3) return null;
    return `${labels[labels.length - 3]}.${lastTwo}`;
  }
  return lastTwo;
}

/**
 * Enforces RFC 6265 cross-site cookie isolation between primary and companion HTTPS origins:
 * - Both origins must be valid HTTPS origins with extractable registrable domains (eTLD+1).
 * - Rejects IP literals, localhost, same-host different-port pairs, parent/child subdomains,
 *   AND sibling subdomains sharing the same registrable site (e.g. `app.aistudy.example` vs
 *   `scratchpad.aistudy.example` share `Domain=aistudy.example` and `SameSite=Strict` scope).
 */
export function areCompanionOriginsIsolated(
  primaryOrigin: string,
  companionOrigin: string,
): boolean {
  const primarySite = extractRegistrableSite(primaryOrigin);
  const companionSite = extractRegistrableSite(companionOrigin);
  if (!primarySite || !companionSite) return false;
  return primarySite !== companionSite;
}

/**
 * Normalizes an RFC 8628 human confirmation code into `XXXX-XXXX` (case/hyphen/space-insensitive
 * on input) while strictly rejecting ambiguous characters (`0`, `O`, `1`, `I`, `L`).
 */
export function normalizeCompanionUserCode(rawUserCode: string): string | null {
  if (!isNonEmptyString(rawUserCode)) return null;
  const compact = rawUserCode.replace(/[-\s]/g, "").toUpperCase();
  if (compact.length !== USER_CODE_LENGTH) return null;
  for (const ch of compact) {
    if (!USER_CODE_CHAR_SET.has(ch)) return null;
  }
  return `${compact.slice(0, 4)}-${compact.slice(4, 8)}`;
}

/**
 * Deterministically maps 8+ caller-supplied entropy bytes onto the unambiguous
 * `XXXX-XXXX` user code alphabet (never emits `0/O/1/I/L`).
 */
export function formatCompanionUserCodeFromBytes(bytes: Uint8Array): string {
  if (bytes.length < USER_CODE_LENGTH) {
    throw new RangeError(`Expected at least ${USER_CODE_LENGTH} bytes to derive a user code.`);
  }
  const alphabetLen = COMPANION_USER_CODE_ALPHABET.length;
  let compact = "";
  for (let i = 0; i < USER_CODE_LENGTH; i += 1) {
    compact += COMPANION_USER_CODE_ALPHABET[(bytes[i] ?? 0) % alphabetLen];
  }
  return `${compact.slice(0, 4)}-${compact.slice(4, 8)}`;
}

export function deriveCompanionFragmentSecretProof(
  fragmentSecret: string,
  deviceCode: string,
): string {
  return sha256Utf8Hex(`aistudy:companion-pair:v1:${deviceCode}:${fragmentSecret}`);
}

function hashDeviceCode(deviceCode: string): string {
  return sha256Utf8Hex(`aistudy:companion-device-code:v1:${deviceCode}`);
}

/**
 * Parses a companion pairing QR URL and extracts the ephemeral secret strictly from
 * the URL fragment (`#k=<fragmentSecret>`). Rejects any URL where `k` appears in the
 * query string or path so server logs / HTTP Referer leaks fail closed.
 */
export function parseCompanionQrUrl(
  qrUrl: string,
):
  | { readonly ok: true; readonly origin: string; readonly pathname: string; readonly fragmentSecret: string }
  | { readonly ok: false; readonly code: "invalid_qr_url" | "secret_outside_fragment"; readonly message: string } {
  let parsed: URL;
  try {
    parsed = new URL(qrUrl);
  } catch {
    return { ok: false, code: "invalid_qr_url", message: "QR URL is not a valid URL." };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, code: "invalid_qr_url", message: "QR URL must use https." };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return {
      ok: false,
      code: "invalid_qr_url",
      message: "QR URL must not contain embedded userinfo credentials.",
    };
  }
  if (parsed.searchParams.has("k")) {
    return {
      ok: false,
      code: "secret_outside_fragment",
      message: "QR URL must never place the ephemeral secret in the query string.",
    };
  }
  if (!parsed.hash.startsWith("#")) {
    return {
      ok: false,
      code: "invalid_qr_url",
      message: "QR URL must place the ephemeral secret in the URL fragment (#k=...).",
    };
  }
  const fragmentParams = new URLSearchParams(parsed.hash.slice(1));
  const fragmentSecret = fragmentParams.get("k");
  if (!isNonEmptyString(fragmentSecret) || fragmentSecret.length < MIN_SECRET_LENGTH) {
    return {
      ok: false,
      code: "invalid_qr_url",
      message: "QR URL fragment #k=<fragmentSecret> is missing or too short.",
    };
  }
  if (
    parsed.pathname.includes(fragmentSecret) ||
    parsed.search.includes(fragmentSecret)
  ) {
    return {
      ok: false,
      code: "secret_outside_fragment",
      message: "QR URL leaked the ephemeral secret into the pathname or query string.",
    };
  }
  return {
    ok: true,
    origin: parsed.origin.toLowerCase(),
    pathname: parsed.pathname,
    fragmentSecret,
  };
}

/**
 * Creates a single-use 90-second RFC 8628 companion scratchpad pairing offer bound to
 * `(workspaceId, learnerId, attemptId)` on an isolated companion origin (`allowedCompanionOrigin !== primaryOrigin`).
 * The QR URL places the ephemeral secret strictly in `#k=<fragmentSecret>`.
 */
export function createCompanionPairingOffer(
  input: CreateCompanionPairingOfferInput,
): CreateCompanionPairingOfferResult {
  if (
    !isNonEmptyString(input.offerId) ||
    !isNonEmptyString(input.workspaceId) ||
    !isNonEmptyString(input.learnerId) ||
    !isNonEmptyString(input.attemptId)
  ) {
    return {
      ok: false,
      code: "invalid_pairing_scope",
      httpStatus: 400,
      message: "offerId, workspaceId, learnerId, and attemptId must be non-empty strings.",
    };
  }
  if (!isValidTimestamp(input.issuedAtMs)) {
    return {
      ok: false,
      code: "invalid_timestamp",
      httpStatus: 400,
      message: "issuedAtMs must be a finite non-negative timestamp.",
    };
  }

  const normalizedPrimaryOrigin = normalizeOrigin(input.primaryOrigin);
  const normalizedCompanionOrigin = normalizeOrigin(input.allowedCompanionOrigin);
  if (!normalizedPrimaryOrigin || !normalizedCompanionOrigin) {
    return {
      ok: false,
      code: "invalid_origin",
      httpStatus: 400,
      message: "primaryOrigin and allowedCompanionOrigin must be valid HTTPS origins.",
    };
  }
  if (!areCompanionOriginsIsolated(normalizedPrimaryOrigin, normalizedCompanionOrigin)) {
    return {
      ok: false,
      code: "origin_isolation_violation",
      httpStatus: 400,
      message: "Companion origin must use a strictly distinct, non-parent/child HTTPS hostname from primaryOrigin so cookies are never shared across ports or Domain suffixes.",
    };
  }

  const normalizedUserCode = normalizeCompanionUserCode(input.userCode);
  if (!normalizedUserCode) {
    return {
      ok: false,
      code: "invalid_user_code",
      httpStatus: 400,
      message: "userCode must normalize to 8 unambiguous characters (XXXX-XXXX, excluding 0/O/1/I/L).",
    };
  }

  if (
    !isNonEmptyString(input.deviceCode) ||
    input.deviceCode.trim().length < MIN_SECRET_LENGTH ||
    !isNonEmptyString(input.fragmentSecret) ||
    input.fragmentSecret.trim().length < MIN_SECRET_LENGTH ||
    /\s/.test(input.fragmentSecret)
  ) {
    return {
      ok: false,
      code: "invalid_secret_material",
      httpStatus: 400,
      message: `deviceCode and fragmentSecret must be non-empty strings of at least ${MIN_SECRET_LENGTH} characters without whitespace.`,
    };
  }

  const pairingPath = input.pairingPath ?? DEFAULT_COMPANION_PAIRING_PATH;
  if (
    !pairingPath.startsWith("/") ||
    pairingPath.includes("?") ||
    pairingPath.includes("#") ||
    pairingPath.includes(input.fragmentSecret)
  ) {
    return {
      ok: false,
      code: "invalid_pairing_path",
      httpStatus: 400,
      message: "pairingPath must be a clean root-relative path without query, fragment, or embedded secret.",
    };
  }

  const deviceCode = input.deviceCode.trim();
  const fragmentSecret = input.fragmentSecret.trim();
  const expiresAtMs = input.issuedAtMs + COMPANION_PAIRING_TTL_MS;
  const qrUrl = `${normalizedCompanionOrigin}${pairingPath}#k=${encodeURIComponent(fragmentSecret)}`;

  const offer: CompanionPairingOffer = {
    schemaVersion: 1,
    offerId: input.offerId.trim(),
    workspaceId: input.workspaceId.trim(),
    learnerId: input.learnerId.trim(),
    attemptId: input.attemptId.trim(),
    primaryOrigin: normalizedPrimaryOrigin,
    allowedCompanionOrigin: normalizedCompanionOrigin,
    userCode: normalizedUserCode,
    deviceCodeHash: hashDeviceCode(deviceCode),
    expectedFragmentSecretProof: deriveCompanionFragmentSecretProof(fragmentSecret, deviceCode),
    status: "pending",
    issuedAtMs: input.issuedAtMs,
    expiresAtMs,
    redeemedAtMs: null,
    issuedSessionId: null,
    replayDetectedAtMs: null,
  };

  return {
    ok: true,
    offer,
    qrUrl,
    userCode: normalizedUserCode,
    expiresAtMs,
  };
}

/**
 * Redeems a single-use companion pairing offer within its 90s TTL and mints a narrowly
 * scoped, single-attempt companion session policy. Any replay against an already-redeemed
 * offer returns `code: "pairing_already_redeemed"` with `revokeIssuedSession: true`.
 */
export function redeemCompanionPairingOffer(
  input: RedeemCompanionPairingOfferInput,
): RedeemCompanionPairingOfferResult {
  const { offer, nowMs } = input;

  if (!isValidTimestamp(nowMs) || nowMs < offer.issuedAtMs) {
    return {
      ok: false,
      code: "invalid_timestamp",
      httpStatus: 400,
      revokeIssuedSession: false,
      revokedSessionId: null,
      offer,
      message: "Redemption timestamp must be a valid timestamp >= offer.issuedAtMs.",
    };
  }

  // Authenticate origin and full pairing credentials BEFORE inspecting redeemed state so
  // unauthenticated probes cannot DoS/revoke an active companion session.
  const normalizedRequestOrigin = normalizeOrigin(input.requestOrigin);
  if (!normalizedRequestOrigin || normalizedRequestOrigin !== offer.allowedCompanionOrigin) {
    return {
      ok: false,
      code: "origin_mismatch",
      httpStatus: 403,
      revokeIssuedSession: false,
      revokedSessionId: null,
      offer,
      message: "Redemption requestOrigin does not match offer.allowedCompanionOrigin.",
    };
  }

  const normalizedUserCode = normalizeCompanionUserCode(input.userCode);
  const candidateDeviceCodeHash = isNonEmptyString(input.deviceCode)
    ? hashDeviceCode(input.deviceCode.trim())
    : "";
  const candidateProof = isNonEmptyString(input.fragmentSecretProof)
    ? input.fragmentSecretProof.trim()
    : "";

  const deviceCodeMatches = constantTimeEqual(candidateDeviceCodeHash, offer.deviceCodeHash);
  const userCodeMatches =
    normalizedUserCode !== null && constantTimeEqual(normalizedUserCode, offer.userCode);
  const proofMatches = constantTimeEqual(candidateProof, offer.expectedFragmentSecretProof);

  if (!deviceCodeMatches || !userCodeMatches || !proofMatches) {
    return {
      ok: false,
      code: "invalid_pairing_credentials",
      httpStatus: 403,
      revokeIssuedSession: false,
      revokedSessionId: null,
      offer,
      message: "Companion pairing credentials failed verification.",
    };
  }

  if (offer.status === "redeemed") {
    return {
      ok: false,
      code: "pairing_already_redeemed",
      httpStatus: 409,
      revokeIssuedSession: true,
      revokedSessionId: offer.issuedSessionId,
      offer: {
        ...offer,
        replayDetectedAtMs: nowMs,
      },
      message: "Authenticated replay of an already-redeemed pairing offer detected; signal immediate revocation of the issued companion session.",
    };
  }

  if (offer.status === "revoked") {
    return {
      ok: false,
      code: "pairing_revoked",
      httpStatus: 410,
      revokeIssuedSession: false,
      revokedSessionId: null,
      offer,
      message: "Pairing offer has been revoked.",
    };
  }

  if (offer.status === "expired" || nowMs > offer.expiresAtMs) {
    return {
      ok: false,
      code: "pairing_expired",
      httpStatus: 410,
      revokeIssuedSession: false,
      revokedSessionId: null,
      offer: offer.status === "expired" ? offer : { ...offer, status: "expired" },
      message: `Pairing offer expired at ${offer.expiresAtMs} (90s ceiling).`,
    };
  }

  if (!isNonEmptyString(input.sessionId)) {
    return {
      ok: false,
      code: "invalid_session_id",
      httpStatus: 400,
      revokeIssuedSession: false,
      revokedSessionId: null,
      offer,
      message: "sessionId must be a non-empty string.",
    };
  }

  const rawSessionTtl = input.sessionTtlMs ?? DEFAULT_COMPANION_SESSION_TTL_MS;
  const boundedSessionTtl =
    Number.isFinite(rawSessionTtl) && rawSessionTtl > 0
      ? Math.min(rawSessionTtl, MAX_COMPANION_SESSION_TTL_MS)
      : DEFAULT_COMPANION_SESSION_TTL_MS;

  const sessionId = input.sessionId.trim();
  const redeemedOffer: CompanionPairingOffer = {
    ...offer,
    status: "redeemed",
    redeemedAtMs: nowMs,
    issuedSessionId: sessionId,
  };

  const session: CompanionSession = {
    schemaVersion: 1,
    sessionId,
    offerId: offer.offerId,
    workspaceId: offer.workspaceId,
    learnerId: offer.learnerId,
    scopedAttemptId: offer.attemptId,
    allowedOrigin: offer.allowedCompanionOrigin,
    status: "active",
    issuedAtMs: nowMs,
    expiresAtMs: nowMs + boundedSessionTtl,
    revokedAtMs: null,
    revokedReason: null,
    allowedActions: ["upload_page", "list_pages", "heartbeat"],
    cookieAttributes: {
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
      path: COMPANION_COOKIE_PATH,
    },
  };

  return {
    ok: true,
    httpStatus: 200,
    offer: redeemedOffer,
    session,
  };
}

export function revokeCompanionSession(
  session: CompanionSession,
  revokedAtMs: number,
  reason = "revoked",
): CompanionSession {
  if (session.status === "revoked") return session;
  return {
    ...session,
    status: "revoked",
    revokedAtMs,
    revokedReason: reason,
  };
}

/**
 * Hard capability firewall for companion sessions. Strictly allowlists ONLY
 * `upload_page`, `list_pages`, and `heartbeat` on the session's bound `scopedAttemptId`.
 * Deterministically rejects reading course materials, Tutor chat, hints, answer keys,
 * submitting/turning in the attempt, cross-attempt access, and revoked/expired sessions.
 */
export function authorizeCompanionAction(
  input: AuthorizeCompanionActionInput,
): AuthorizeCompanionActionResult {
  const { session, action, attemptId, nowMs, requestOrigin } = input;

  if (session.status === "revoked") {
    return {
      allowed: false,
      httpStatus: 403,
      reason: "session_revoked",
      message: "Companion session has been revoked.",
    };
  }

  if (
    !isValidTimestamp(nowMs) ||
    session.status === "expired" ||
    nowMs > session.expiresAtMs ||
    nowMs < session.issuedAtMs
  ) {
    return {
      allowed: false,
      httpStatus: 403,
      reason: "session_expired",
      message: "Companion session has expired.",
    };
  }

  const normalizedRequestOrigin = normalizeOrigin(requestOrigin);
  if (!normalizedRequestOrigin || normalizedRequestOrigin !== session.allowedOrigin) {
    return {
      allowed: false,
      httpStatus: 403,
      reason: "companion_capability_forbidden",
      message: "Companion request origin does not match the session's isolated origin.",
    };
  }

  if (attemptId !== session.scopedAttemptId) {
    return {
      allowed: false,
      httpStatus: 403,
      reason: "attempt_mismatch",
      message: `Companion session is strictly bound to attempt ${session.scopedAttemptId}.`,
    };
  }

  // Defense-in-depth: check BOTH the hardcoded constant allowlist AND session.allowedActions.
  if (
    !isAllowedCompanionAction(action) ||
    !(session.allowedActions as ReadonlyArray<string>).includes(action)
  ) {
    return {
      allowed: false,
      httpStatus: 403,
      reason: "companion_capability_forbidden",
      message: `Action "${action}" is forbidden on companion scratchpad sessions.`,
    };
  }

  return {
    allowed: true,
    httpStatus: 200,
    action,
    scopedAttemptId: session.scopedAttemptId,
  };
}

export function createCompanionScratchpadDraft(input: {
  readonly workspaceId: string;
  readonly learnerId: string;
  readonly attemptId: string;
}): CompanionScratchpadState {
  return {
    schemaVersion: 1,
    workspaceId: input.workspaceId,
    learnerId: input.learnerId,
    attemptId: input.attemptId,
    draftRevision: 0,
    frozen: false,
    frozenAtMs: null,
    frozenRevision: null,
    pages: [],
  };
}

/**
 * Appends (or replaces by pageNumber) a companion scratchpad page and increments
 * `draftRevision` monotonically while `frozen === false`. Unconditionally verifies the
 * mandatory companion `session`, `requestOrigin`, and `nowMs` via `authorizeCompanionAction`
 * before allowing any write, and rejects writes once frozen.
 */
export function appendCompanionScratchpadPage(
  state: CompanionScratchpadState,
  input: AppendCompanionScratchpadPageInput,
): AppendCompanionScratchpadPageResult {
  if (!input.session || typeof input.requestOrigin !== "string") {
    return {
      ok: false,
      code: "companion_capability_forbidden",
      httpStatus: 403,
      state,
      message: "A verified companion session and requestOrigin are mandatory to upload scratchpad pages.",
    };
  }

  const auth = authorizeCompanionAction({
    session: input.session,
    action: "upload_page",
    attemptId: state.attemptId,
    nowMs: input.nowMs,
    requestOrigin: input.requestOrigin,
  });
  if (!auth.allowed) {
    return {
      ok: false,
      code: auth.reason,
      httpStatus: 403,
      state,
      message: auth.message,
    };
  }

  if (
    input.session.workspaceId !== state.workspaceId ||
    input.session.learnerId !== state.learnerId
  ) {
    return {
      ok: false,
      code: "attempt_mismatch",
      httpStatus: 403,
      state,
      message: "Companion session workspace/learner scope does not match scratchpad draft.",
    };
  }

  if (state.frozen) {
    return {
      ok: false,
      code: "scratchpad_already_frozen",
      httpStatus: 409,
      state,
      message: "Scratchpad has already been frozen for submission.",
    };
  }

  const effectiveUploadedAtMs = input.uploadedAtMs ?? input.nowMs;

  if (
    !Number.isSafeInteger(input.pageNumber) ||
    input.pageNumber < 1 ||
    !isNonEmptyString(input.objectKey) ||
    !isNonEmptyString(input.sha256) ||
    !SHA256_HEX_RE.test(input.sha256.trim()) ||
    !Number.isSafeInteger(input.byteLength) ||
    input.byteLength <= 0 ||
    !isValidTimestamp(effectiveUploadedAtMs)
  ) {
    return {
      ok: false,
      code: "invalid_page_payload",
      httpStatus: 400,
      state,
      message: "Scratchpad page requires positive pageNumber, objectKey, 64-char hex sha256, positive byteLength, and valid timestamp.",
    };
  }

  const nextRevision = state.draftRevision + 1;
  const newPage: CompanionScratchpadPage = {
    pageNumber: input.pageNumber,
    objectKey: input.objectKey.trim(),
    sha256: input.sha256.trim().toLowerCase(),
    byteLength: input.byteLength,
    uploadedAtMs: effectiveUploadedAtMs,
    uploadedInRevision: nextRevision,
  };

  const nextPages = [
    ...state.pages.filter(page => page.pageNumber !== newPage.pageNumber),
    newPage,
  ].sort((a, b) => a.pageNumber - b.pageNumber);

  const nextState: CompanionScratchpadState = {
    ...state,
    draftRevision: nextRevision,
    pages: nextPages,
  };

  return {
    ok: true,
    httpStatus: 200,
    draftRevision: nextRevision,
    page: newPage,
    state: nextState,
  };
}

/**
 * Atomically freezes the companion scratchpad draft for desktop submission only when
 * `expectedDraftRevision === state.draftRevision`. Fails closed with `409 draft_changed`
 * if a tablet page raced in after the desktop preview snapshot.
 */
export function freezeCompanionScratchpadForSubmit(
  state: CompanionScratchpadState,
  input: FreezeCompanionScratchpadInput,
): FreezeCompanionScratchpadResult {
  if (
    !Number.isSafeInteger(input.expectedDraftRevision) ||
    input.expectedDraftRevision < 0 ||
    !isValidTimestamp(input.frozenAtMs)
  ) {
    return {
      ok: false,
      code: "invalid_freeze_input",
      httpStatus: 400,
      currentDraftRevision: state.draftRevision,
      state,
      message: "Freeze requires a non-negative integer expectedDraftRevision and valid frozenAtMs.",
    };
  }

  if (state.frozen) {
    return {
      ok: false,
      code: "scratchpad_already_frozen",
      httpStatus: 409,
      currentDraftRevision: state.draftRevision,
      state,
      message: "Scratchpad has already been frozen.",
    };
  }

  if (state.draftRevision !== input.expectedDraftRevision) {
    return {
      ok: false,
      code: "draft_changed",
      httpStatus: 409,
      currentDraftRevision: state.draftRevision,
      state,
      message: `Scratchpad draft changed concurrently (expected=${input.expectedDraftRevision}, current=${state.draftRevision}).`,
    };
  }

  const frozenPages = state.pages.map(page => ({ ...page }));
  const nextState: CompanionScratchpadState = {
    ...state,
    frozen: true,
    frozenAtMs: input.frozenAtMs,
    frozenRevision: state.draftRevision,
    pages: frozenPages,
  };

  return {
    ok: true,
    httpStatus: 200,
    frozen: true,
    frozenAtMs: input.frozenAtMs,
    frozenRevision: state.draftRevision,
    frozenPages,
    state: nextState,
  };
}
