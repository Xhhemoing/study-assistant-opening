import { createEmptyCard, fsrs, Rating, type Card, type Grade } from "ts-fsrs";
import {
  FORBIDDEN_MISS_VARIANT_FIELDS,
  MAX_OFFLINE_LEASE_CARDS,
  OFFLINE_LEASE_TTL_MS,
  type IssueOfflineFlashcardLeaseInput,
  type IssueOfflineFlashcardLeaseResult,
  type OfflineEffectiveRating,
  type OfflineFlashcardLease,
  type OfflineFsrsMemoryState,
  type OfflineLeaseCard,
  type OfflineLeaseCardCandidate,
  type OfflineLeasedMissVariantCard,
  type OfflineLeasedStandardFlashcard,
  type OfflineOutboxEntryInput,
  type OfflineOutboxItemResult,
  type OfflineOutboxLedgerEntry,
  type OfflineRawRating,
  type OfflineSettledReceipt,
  type ReconcileOfflineLeaseOutboxInput,
  type ReconcileOfflineLeaseOutboxResult,
  type ServerFlashcardSnapshot,
} from "./types";

const DAY_MS = 86_400_000;
const FSRS_ENGINE = fsrs({ request_retention: 0.9, enable_fuzz: false });

const EFFECTIVE_RATING_TO_FSRS: Record<OfflineEffectiveRating, Grade> = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
};

const VALID_RAW_RATINGS: ReadonlySet<string> = new Set<OfflineRawRating>([
  "again",
  "hard",
  "good",
  "easy",
]);

const STRIPPABLE_CLIENT_PROMOTION_FLAGS = [
  "delayedCheck",
  "transferVerified",
  "promoteMastery",
] as const;

const SOLUTION_DIRECTIVE_PATTERNS: ReadonlyArray<RegExp> = [
  /\\begin\s*\{\s*(?:solution|answer|answers|proof|rubric|key|grading|hint)\*?\s*\}/i,
  /(?:^|\n)\s*:{3,}\s*(?:solution|answer|rubric|key|grading)\b/i,
  /(?:^|\n)\s*`{3,}\s*(?:solution|answer|rubric|key|grading)\b/i,
  /<\s*(?:details|summary)\b/i,
  /\[\s*(?:answer|ans|solution|sol|key|rubric|canonical\s+solution|reference\s+answer)\s*[:：=]/i,
  /(?:\*\*|__)\s*(?:answer|ans|solution|canonical\s+solution|reference\s+answer|answer\s+key|grading\s+rubric)\s*[:：=]?\s*(?:\*\*|__)/i,
  /(?:\*|_)\s*(?:answer|ans|solution|canonical\s+solution|reference\s+answer|answer\s+key|grading\s+rubric)\s*(?:[:：=]\s*(?:\*|_)|(?:\*|_)\s*[:：=])/i,
  /(?:^|[\s,.;!?()[\]*_])(?:answer|ans|solution|canonical\s+solution|reference\s+answer|answer\s+key|grading\s+rubric)\s*(?:\*{1,3}|_{1,3})?\s*[:：=]/i,
  /(?:\*{1,3}|_{1,3})?(?:参考答案|标准答案|正确答案|答案|解析|解答|解题过程|评分标准|解)(?:\*{1,3}|_{1,3})?\s*[:：=]/,
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsTokenBoundedSubstring(haystack: string, needle: string): boolean {
  const pattern = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(needle)}(?:$|[^a-z0-9])`, "i");
  return pattern.test(haystack);
}

function containsSolutionDirectiveMarker(rawStem: string): boolean {
  return SOLUTION_DIRECTIVE_PATTERNS.some(pattern => pattern.test(rawStem));
}

function extractLeakSegments(normalizedSecret: string): string[] {
  const segments = new Set<string>([normalizedSecret]);
  for (const part of normalizedSecret.split(/[\n;]+|\.\s+|\bstep\s*\d+\s*[:.)]\s*/i)) {
    const trimmed = part.trim();
    if (trimmed.length >= 10 || (trimmed.length >= 6 && trimmed.split(/\s+/).length >= 3)) {
      segments.add(trimmed);
    }
  }
  return [...segments];
}

function stemLeaksSecretText(normalizedStem: string, secretText: string): boolean {
  const normalizedSecret = normalizeComparableText(secretText);
  if (!normalizedSecret) return false;
  if (normalizedStem === normalizedSecret) return true;

  for (const segment of extractLeakSegments(normalizedSecret)) {
    if (segment.length >= 6 && normalizedStem.includes(segment)) {
      return true;
    }
    const tokenCount = segment.split(/\s+/).filter(Boolean).length;
    if (tokenCount >= 2 && segment.length >= 4 && containsTokenBoundedSubstring(normalizedStem, segment)) {
      return true;
    }
    if (segment.includes("=")) {
      const compactEq = segment.replace(/\s*=\s*/g, "=");
      if (compactEq.length >= 3) {
        const eqRegexSource = escapeRegExp(compactEq).replace(/=/g, "\\s*=\\s*");
        const eqPattern = new RegExp(`(?:^|[^a-z0-9])${eqRegexSource}(?:$|[^a-z0-9])`, "i");
        if (eqPattern.test(normalizedStem)) {
          return true;
        }
      }
    }
  }
  return false;
}

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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function normalizeComparableText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function collectSecretTexts(value: unknown, depth = 0): string[] {
  if (value === null || value === undefined || depth > 4) return [];
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return [String(value)];
  }
  if (Array.isArray(value)) {
    return value.flatMap(item => collectSecretTexts(item, depth + 1));
  }
  if (typeof value === "object") {
    const results: string[] = [];
    try {
      const serialized = JSON.stringify(value);
      if (serialized && serialized !== "{}" && serialized !== "[]") {
        results.push(serialized);
      }
    } catch {
      // Ignore unserializable metadata.
    }
    for (const nested of Object.values(value as Record<string, unknown>)) {
      results.push(...collectSecretTexts(nested, depth + 1));
    }
    return results;
  }
  return [];
}

function canonicalizeForFingerprint(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : '"non-finite"';
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(item => canonicalizeForFingerprint(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter(key => record[key] !== undefined)
      .sort((a, b) => a.localeCompare(b));
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalizeForFingerprint(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(String(value));
}

function serializeFsrsCard(card: Card): OfflineFsrsMemoryState {
  return {
    stability: card.stability,
    difficulty: card.difficulty,
    elapsedDays: card.elapsed_days,
    scheduledDays: card.scheduled_days,
    learningSteps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
    lastReviewAtMs: card.last_review ? card.last_review.getTime() : null,
  };
}

function cloneServerSnapshot(snapshot: ServerFlashcardSnapshot): ServerFlashcardSnapshot {
  return {
    ...snapshot,
    fsrs: snapshot.fsrs ? { ...snapshot.fsrs } : null,
  };
}

function cloneLedgerEntry(entry: OfflineOutboxLedgerEntry): OfflineOutboxLedgerEntry {
  return {
    ...entry,
    receipt: {
      ...entry.receipt,
      strippedClientFlags: [...entry.receipt.strippedClientFlags],
      nextSnapshot: cloneServerSnapshot(entry.receipt.nextSnapshot),
    },
  };
}

function toServerCardRecord(
  cards:
    | Readonly<Record<string, ServerFlashcardSnapshot>>
    | ReadonlyMap<string, ServerFlashcardSnapshot>,
): Record<string, ServerFlashcardSnapshot> {
  const out: Record<string, ServerFlashcardSnapshot> = {};
  if (cards instanceof Map) {
    for (const [cardId, snapshot] of cards.entries()) {
      out[cardId] = cloneServerSnapshot(snapshot);
    }
    return out;
  }
  for (const [cardId, snapshot] of Object.entries(cards)) {
    out[cardId] = cloneServerSnapshot(snapshot);
  }
  return out;
}

function toLedgerRecord(
  ledger:
    | Readonly<Record<string, OfflineOutboxLedgerEntry>>
    | ReadonlyMap<string, OfflineOutboxLedgerEntry>
    | undefined,
): Record<string, OfflineOutboxLedgerEntry> {
  const out: Record<string, OfflineOutboxLedgerEntry> = {};
  if (!ledger) return out;
  if (ledger instanceof Map) {
    for (const [key, entry] of ledger.entries()) {
      out[key] = cloneLedgerEntry(entry);
    }
    return out;
  }
  for (const [key, entry] of Object.entries(ledger)) {
    out[key] = cloneLedgerEntry(entry);
  }
  return out;
}

function sanitizeLeaseCandidate(
  candidate: OfflineLeaseCardCandidate,
):
  | { readonly ok: true; readonly card: OfflineLeaseCard }
  | {
      readonly ok: false;
      readonly code: "invalid_card_payload" | "miss_variant_stem_required" | "miss_variant_answer_leak";
      readonly httpStatus: 400 | 422;
      readonly message: string;
      readonly cardId?: string;
    } {
  const candidateCardId = isNonEmptyString(candidate.cardId) ? candidate.cardId : undefined;
  if (!candidateCardId) {
    return {
      ok: false,
      code: "invalid_card_payload",
      httpStatus: 400,
      message: "Lease card candidate must provide a non-empty cardId.",
    };
  }
  if (!isNonNegativeSafeInteger(candidate.cardRevision)) {
    return {
      ok: false,
      code: "invalid_card_payload",
      httpStatus: 400,
      cardId: candidateCardId,
      message: `Card ${candidateCardId} must have a non-negative integer cardRevision.`,
    };
  }
  if (candidate.lastServerReviewedAtMs !== null && !isValidTimestamp(candidate.lastServerReviewedAtMs)) {
    return {
      ok: false,
      code: "invalid_card_payload",
      httpStatus: 400,
      cardId: candidateCardId,
      message: `Card ${candidateCardId} has an invalid lastServerReviewedAtMs.`,
    };
  }

  if (candidate.cardKind === "flashcard") {
    if (!isNonEmptyString(candidate.prompt) || !isNonEmptyString(candidate.backSummary)) {
      return {
        ok: false,
        code: "invalid_card_payload",
        httpStatus: 400,
        cardId: candidateCardId,
        message: `Flashcard ${candidateCardId} requires non-empty prompt and backSummary.`,
      };
    }
    // Defense-in-depth: fail closed if a flashcard candidate carries any forbidden
    // exam/miss-variant secret fields (`sealedPayload`, `answerKey`, `canonicalSolution`,
    // `gradingRubric`, `referenceAnswer`) so sealed problem material cannot bypass sanitization
    // by being mislabeled as `cardKind: "flashcard"`.
    const rawCandidate = candidate as Record<string, unknown>;
    for (const forbiddenField of FORBIDDEN_MISS_VARIANT_FIELDS) {
      const value = rawCandidate[forbiddenField];
      if (value !== undefined && value !== null) {
        return {
          ok: false,
          code: "miss_variant_answer_leak",
          httpStatus: 422,
          cardId: candidateCardId,
          message: `Flashcard ${candidateCardId} refused: forbidden sealed/answer field ${forbiddenField} is not permitted on flashcard lease candidates.`,
        };
      }
    }
    if (containsSolutionDirectiveMarker(candidate.prompt)) {
      return {
        ok: false,
        code: "miss_variant_answer_leak",
        httpStatus: 422,
        cardId: candidateCardId,
        message: `Flashcard ${candidateCardId} refused: prompt contains solution/answer directive markup.`,
      };
    }
    const sanitized: OfflineLeasedStandardFlashcard = {
      cardId: candidateCardId.trim(),
      cardKind: "flashcard",
      cardRevision: candidate.cardRevision,
      lastServerReviewedAtMs: candidate.lastServerReviewedAtMs,
      prompt: candidate.prompt,
      backSummary: candidate.backSummary,
    };
    return { ok: true, card: sanitized };
  }

  if (candidate.cardKind === "miss_variant") {
    if (!isNonEmptyString(candidate.freshVariantId) || !isNonEmptyString(candidate.freshVariantStem)) {
      return {
        ok: false,
        code: "miss_variant_stem_required",
        httpStatus: 422,
        cardId: candidateCardId,
        message: `Miss variant card ${candidateCardId} must include non-empty freshVariantId and freshVariantStem.`,
      };
    }
    if (containsSolutionDirectiveMarker(candidate.freshVariantStem)) {
      return {
        ok: false,
        code: "miss_variant_answer_leak",
        httpStatus: 422,
        cardId: candidateCardId,
        message: `Miss variant card ${candidateCardId} refused: freshVariantStem contains solution/answer directive markup.`,
      };
    }
    const normalizedStem = normalizeComparableText(candidate.freshVariantStem);
    for (const forbiddenField of FORBIDDEN_MISS_VARIANT_FIELDS) {
      const rawSecret = (candidate as Record<string, unknown>)[forbiddenField];
      const secretTexts = collectSecretTexts(rawSecret);
      for (const secretText of secretTexts) {
        if (stemLeaksSecretText(normalizedStem, secretText)) {
          return {
            ok: false,
            code: "miss_variant_answer_leak",
            httpStatus: 422,
            cardId: candidateCardId,
            message: `Miss variant card ${candidateCardId} refused: freshVariantStem leaks ${forbiddenField}.`,
          };
        }
      }
    }

    // Strict allowlist construction: physically excludes answerKey, canonicalSolution,
    // gradingRubric, sealedPayload, referenceAnswer, and any unknown properties.
    const sanitized: OfflineLeasedMissVariantCard = {
      cardId: candidateCardId.trim(),
      cardKind: "miss_variant",
      cardRevision: candidate.cardRevision,
      lastServerReviewedAtMs: candidate.lastServerReviewedAtMs,
      freshVariantId: candidate.freshVariantId.trim(),
      freshVariantStem: candidate.freshVariantStem,
    };
    return { ok: true, card: sanitized };
  }

  return {
    ok: false,
    code: "invalid_card_payload",
    httpStatus: 400,
    cardId: candidateCardId,
    message: `Card ${candidateCardId} has unsupported cardKind.`,
  };
}

/**
 * Runtime assertion helper guaranteeing a minted miss-variant card carries zero
 * forbidden answer-key / rubric / sealed-payload fields.
 */
export function hasForbiddenMissVariantFields(card: unknown): boolean {
  if (typeof card !== "object" || card === null) return false;
  const record = card as Record<string, unknown>;
  return FORBIDDEN_MISS_VARIANT_FIELDS.some(field => Object.prototype.hasOwnProperty.call(record, field));
}

export function createInitialOfflineFsrsSnapshot(
  cardId: string,
  nowMs: number,
  revision = 0,
): ServerFlashcardSnapshot {
  const initialCard = createEmptyCard(new Date(nowMs));
  return {
    cardId,
    revision,
    lastServerReviewedAtMs: null,
    dueAtMs: nowMs,
    intervalDays: 0,
    reps: 0,
    lapses: 0,
    lastGrade: null,
    updatedAtMs: nowMs,
    fsrs: serializeFsrsCard(initialCard),
  };
}

export function offlineOutboxIdempotencyKey(leaseId: string, seq: number): string {
  return `${leaseId}:${seq}`;
}

export function computeOfflineOutboxPayloadFingerprint(entry: OfflineOutboxEntryInput): string {
  return sha256Utf8Hex(canonicalizeForFingerprint(entry));
}

/**
 * Issues a 12-hour single-active offline flashcard lease for `(workspaceId, learnerId)`
 * containing `1..30` strictly sanitized cards. Any prior active lease for the same
 * `(workspaceId, learnerId)` is atomically marked `"superseded"`.
 */
export function issueOfflineFlashcardLease(
  input: IssueOfflineFlashcardLeaseInput,
): IssueOfflineFlashcardLeaseResult {
  if (
    !isNonEmptyString(input.leaseId) ||
    !isNonEmptyString(input.workspaceId) ||
    !isNonEmptyString(input.learnerId)
  ) {
    return {
      ok: false,
      code: "invalid_lease_scope",
      httpStatus: 400,
      message: "leaseId, workspaceId, and learnerId must be non-empty strings.",
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
  if (input.candidates.length === 0) {
    return {
      ok: false,
      code: "empty_lease_cards",
      httpStatus: 400,
      message: "Offline lease requires at least 1 card.",
    };
  }
  if (input.candidates.length > MAX_OFFLINE_LEASE_CARDS) {
    return {
      ok: false,
      code: "lease_card_limit_exceeded",
      httpStatus: 400,
      message: `Offline lease cannot exceed ${MAX_OFFLINE_LEASE_CARDS} cards.`,
    };
  }

  const leaseId = input.leaseId.trim();
  const workspaceId = input.workspaceId.trim();
  const learnerId = input.learnerId.trim();

  let supersededLeaseId: string | null = null;
  let supersededLease: OfflineFlashcardLease | null = null;

  if (input.existingActiveLease) {
    const prior = input.existingActiveLease;
    if (prior.workspaceId !== workspaceId || prior.learnerId !== learnerId) {
      return {
        ok: false,
        code: "supersede_scope_mismatch",
        httpStatus: 409,
        message: "Cannot supersede an active lease belonging to a different workspace or learner.",
      };
    }
    if (prior.leaseId === leaseId) {
      return {
        ok: false,
        code: "duplicate_lease_id",
        httpStatus: 409,
        message: "New leaseId must differ from the prior active leaseId.",
      };
    }
    if (prior.status === "active") {
      supersededLeaseId = prior.leaseId;
      supersededLease = {
        ...prior,
        status: "superseded",
        supersededAtMs: input.issuedAtMs,
        supersededByLeaseId: leaseId,
      };
    }
  }

  const seenCardIds = new Set<string>();
  const sanitizedCards: OfflineLeaseCard[] = [];
  for (const candidate of input.candidates) {
    const sanitized = sanitizeLeaseCandidate(candidate);
    if (!sanitized.ok) {
      return sanitized;
    }
    if (seenCardIds.has(sanitized.card.cardId)) {
      return {
        ok: false,
        code: "duplicate_card_id",
        httpStatus: 400,
        cardId: sanitized.card.cardId,
        message: `Duplicate cardId ${sanitized.card.cardId} in offline lease request.`,
      };
    }
    seenCardIds.add(sanitized.card.cardId);
    sanitizedCards.push(sanitized.card);
  }

  const lease: OfflineFlashcardLease = {
    schemaVersion: 1,
    leaseId,
    workspaceId,
    learnerId,
    status: "active",
    issuedAtMs: input.issuedAtMs,
    expiresAtMs: input.issuedAtMs + OFFLINE_LEASE_TTL_MS,
    supersededAtMs: null,
    supersededByLeaseId: null,
    revokedAtMs: null,
    cards: sanitizedCards,
  };

  return {
    ok: true,
    lease,
    supersededLeaseId,
    supersededLease,
  };
}

export function revokeOfflineFlashcardLease(
  lease: OfflineFlashcardLease,
  revokedAtMs: number,
): OfflineFlashcardLease {
  if (lease.status !== "active") return lease;
  return {
    ...lease,
    status: "revoked",
    revokedAtMs,
  };
}

function scheduleServerReceiptFsrs(
  snapshot: ServerFlashcardSnapshot,
  effectiveRating: OfflineEffectiveRating,
  serverReceiptAtMs: number,
): ServerFlashcardSnapshot {
  const receiptDate = new Date(serverReceiptAtMs);
  const saved = snapshot.fsrs;
  const card: Card = saved
    ? {
        due: new Date(snapshot.dueAtMs),
        stability: saved.stability,
        difficulty: saved.difficulty,
        elapsed_days: saved.elapsedDays,
        scheduled_days: saved.scheduledDays,
        learning_steps: saved.learningSteps,
        reps: saved.reps,
        lapses: saved.lapses,
        state: saved.state,
        ...(saved.lastReviewAtMs !== null ? { last_review: new Date(saved.lastReviewAtMs) } : {}),
      }
    : createEmptyCard(receiptDate);

  const nextCard = FSRS_ENGINE.next(card, receiptDate, EFFECTIVE_RATING_TO_FSRS[effectiveRating]).card;
  const dueAtMs = nextCard.due.getTime();
  return {
    cardId: snapshot.cardId,
    revision: snapshot.revision + 1,
    lastServerReviewedAtMs: serverReceiptAtMs,
    dueAtMs,
    intervalDays: Math.max(0, Math.floor((dueAtMs - serverReceiptAtMs) / DAY_MS)),
    reps: snapshot.reps + 1,
    lapses: snapshot.lapses + (effectiveRating === "again" ? 1 : 0),
    lastGrade: effectiveRating,
    updatedAtMs: serverReceiptAtMs,
    fsrs: serializeFsrsCard(nextCard),
  };
}

function detectStrippedClientFlags(entry: OfflineOutboxEntryInput): ReadonlyArray<string> {
  const record = entry as Record<string, unknown>;
  const stripped: string[] = [];
  for (const flag of STRIPPABLE_CLIENT_PROMOTION_FLAGS) {
    if (record[flag] !== undefined && record[flag] !== false && record[flag] !== null) {
      stripped.push(flag);
    }
  }
  return stripped;
}

/**
 * Reconciles an offline flashcard lease outbox batch with:
 * - strict lease liveness check evaluated at `serverReceiptAtMs` (never `clientReviewedAtMs`)
 * - idempotent `(leaseId, seq)` deduplication & `409 seq_payload_mismatch` fail-closed check
 * - `409 reviewed_elsewhere` desktop race protection
 * - FSRS scheduling strictly at `serverReceiptAtMs` with `"easy" -> "good"` cap
 * - zero `delayedCheck` / mastery / transfer promotion minting
 */
export function reconcileOfflineLeaseOutbox(
  input: ReconcileOfflineLeaseOutboxInput,
): ReconcileOfflineLeaseOutboxResult {
  const workingCards = toServerCardRecord(input.serverCards);
  const workingLedger = toLedgerRecord(input.processedLedger);
  const { lease, serverReceiptAtMs } = input;

  if (!isValidTimestamp(serverReceiptAtMs) || serverReceiptAtMs < lease.issuedAtMs) {
    return {
      ok: false,
      leaseStatus: "invalid_server_clock",
      httpStatus: 400,
      serverReceiptAtMs,
      settledCount: 0,
      replayedCount: 0,
      conflictCount: 0,
      results: [],
      updatedServerCards: workingCards,
      nextProcessedLedger: workingLedger,
      message: "serverReceiptAtMs must be a valid timestamp >= lease.issuedAtMs.",
    };
  }

  if (lease.status === "superseded") {
    return {
      ok: false,
      leaseStatus: "lease_superseded",
      httpStatus: 409,
      serverReceiptAtMs,
      settledCount: 0,
      replayedCount: 0,
      conflictCount: 0,
      results: [],
      updatedServerCards: workingCards,
      nextProcessedLedger: workingLedger,
      message: `Lease ${lease.leaseId} has been superseded by a newer lease.`,
    };
  }

  if (lease.status === "revoked") {
    return {
      ok: false,
      leaseStatus: "lease_revoked",
      httpStatus: 403,
      serverReceiptAtMs,
      settledCount: 0,
      replayedCount: 0,
      conflictCount: 0,
      results: [],
      updatedServerCards: workingCards,
      nextProcessedLedger: workingLedger,
      message: `Lease ${lease.leaseId} has been revoked.`,
    };
  }

  if (lease.status === "expired" || serverReceiptAtMs > lease.expiresAtMs) {
    return {
      ok: false,
      leaseStatus: "lease_expired",
      httpStatus: 410,
      serverReceiptAtMs,
      settledCount: 0,
      replayedCount: 0,
      conflictCount: 0,
      results: [],
      updatedServerCards: workingCards,
      nextProcessedLedger: workingLedger,
      message: `Lease ${lease.leaseId} expired at ${lease.expiresAtMs}; serverReceiptAtMs=${serverReceiptAtMs}.`,
    };
  }

  const leasedCardById = new Map<string, OfflineLeaseCard>();
  for (const card of lease.cards) {
    leasedCardById.set(card.cardId, card);
  }

  // Deterministic ordering: settle valid positive seq entries in ascending seq order
  // (ties preserve arrival order), while invalid seq entries fail closed deterministically.
  const orderedEntries = input.entries
    .map((entry, originalIndex) => ({ entry, originalIndex }))
    .sort((a, b) => {
      const aValid = Number.isSafeInteger(a.entry.seq) && a.entry.seq >= 1;
      const bValid = Number.isSafeInteger(b.entry.seq) && b.entry.seq >= 1;
      if (aValid && bValid && a.entry.seq !== b.entry.seq) {
        return a.entry.seq - b.entry.seq;
      }
      if (aValid !== bValid) return aValid ? -1 : 1;
      return a.originalIndex - b.originalIndex;
    });

  const results: OfflineOutboxItemResult[] = [];
  let settledCount = 0;
  let replayedCount = 0;
  let conflictCount = 0;

  for (const { entry } of orderedEntries) {
    if (entry.leaseId !== lease.leaseId) {
      conflictCount += 1;
      results.push({
        leaseId: entry.leaseId,
        seq: entry.seq,
        cardId: entry.cardId,
        outcome: "lease_mismatch",
        httpStatus: 409,
        reason: `Outbox entry leaseId ${entry.leaseId} does not match active lease ${lease.leaseId}.`,
      });
      continue;
    }

    if (!Number.isSafeInteger(entry.seq) || entry.seq < 1) {
      results.push({
        leaseId: entry.leaseId,
        seq: entry.seq,
        cardId: entry.cardId,
        outcome: "invalid_seq",
        httpStatus: 400,
        reason: "Outbox seq must be a positive safe integer (>= 1).",
      });
      continue;
    }

    const payloadFingerprint = computeOfflineOutboxPayloadFingerprint(entry);
    const idempotencyKey = offlineOutboxIdempotencyKey(lease.leaseId, entry.seq);
    const existingLedgerEntry = workingLedger[idempotencyKey];

    // Idempotency check runs BEFORE desktop race checks so retries of already-settled
    // `(leaseId, seq)` entries always return cached receipt without false 409s.
    if (existingLedgerEntry) {
      if (existingLedgerEntry.payloadFingerprint === payloadFingerprint) {
        replayedCount += 1;
        const cachedReceipt = cloneLedgerEntry(existingLedgerEntry).receipt;
        results.push({
          leaseId: lease.leaseId,
          seq: entry.seq,
          cardId: cachedReceipt.cardId,
          outcome: "replayed",
          httpStatus: 200,
          payloadFingerprint,
          effectiveRating: cachedReceipt.effectiveRating,
          clampedFromEasy: cachedReceipt.clampedFromEasy,
          authorityClock: "server_receipt",
          effectiveReviewedAtMs: cachedReceipt.effectiveReviewedAtMs,
          delayedCheckMinted: false,
          allowMasteryPromotion: false,
          transferVerified: false,
          receipt: cachedReceipt,
        });
      } else {
        conflictCount += 1;
        results.push({
          leaseId: lease.leaseId,
          seq: entry.seq,
          cardId: entry.cardId,
          outcome: "seq_payload_mismatch",
          httpStatus: 409,
          payloadFingerprint,
          expectedPayloadFingerprint: existingLedgerEntry.payloadFingerprint,
          reason: `Conflicting payload for (${lease.leaseId}, seq=${entry.seq}).`,
        });
      }
      continue;
    }

    if (
      !isNonEmptyString(entry.cardId) ||
      !isNonNegativeSafeInteger(entry.expectedCardRevision) ||
      !VALID_RAW_RATINGS.has(entry.rating)
    ) {
      results.push({
        leaseId: lease.leaseId,
        seq: entry.seq,
        cardId: entry.cardId,
        outcome: "invalid_entry",
        httpStatus: 400,
        reason: "Outbox entry requires valid cardId, non-negative expectedCardRevision, and valid rating.",
      });
      continue;
    }

    const leasedCard = leasedCardById.get(entry.cardId);
    if (!leasedCard) {
      results.push({
        leaseId: lease.leaseId,
        seq: entry.seq,
        cardId: entry.cardId,
        outcome: "card_not_in_lease",
        httpStatus: 403,
        reason: `Card ${entry.cardId} is not covered by lease ${lease.leaseId}.`,
      });
      continue;
    }

    const serverCard = workingCards[entry.cardId];
    if (!serverCard) {
      results.push({
        leaseId: lease.leaseId,
        seq: entry.seq,
        cardId: entry.cardId,
        outcome: "card_not_found",
        httpStatus: 404,
        reason: `Server card snapshot ${entry.cardId} was not found.`,
      });
      continue;
    }

    // Compare live serverCard.revision and client expectedCardRevision against the
    // authoritative leasedCard.cardRevision snapshot minted into the lease (never trust
    // a client claiming a newer revision to overwrite a same-millisecond desktop review).
    const fsrsLastReviewAtMs = serverCard.fsrs?.lastReviewAtMs ?? null;
    const serverMovedFromLease = serverCard.revision !== leasedCard.cardRevision;
    const expectedRevisionMismatch =
      entry.expectedCardRevision !== leasedCard.cardRevision ||
      serverCard.revision !== entry.expectedCardRevision;
    const serverReviewedSinceLease =
      serverCard.lastServerReviewedAtMs !== null &&
      (serverCard.lastServerReviewedAtMs > lease.issuedAtMs ||
        (serverCard.lastServerReviewedAtMs >= lease.issuedAtMs &&
          (serverMovedFromLease ||
            serverCard.lastServerReviewedAtMs !== leasedCard.lastServerReviewedAtMs)));
    const fsrsReviewedSinceLease =
      fsrsLastReviewAtMs !== null &&
      (fsrsLastReviewAtMs > lease.issuedAtMs ||
        (fsrsLastReviewAtMs >= lease.issuedAtMs &&
          (serverMovedFromLease || fsrsLastReviewAtMs !== leasedCard.lastServerReviewedAtMs)));
    const reviewAheadOfServerClock =
      fsrsLastReviewAtMs !== null && fsrsLastReviewAtMs > serverReceiptAtMs;

    if (
      serverMovedFromLease ||
      expectedRevisionMismatch ||
      serverReviewedSinceLease ||
      fsrsReviewedSinceLease ||
      reviewAheadOfServerClock
    ) {
      conflictCount += 1;
      results.push({
        leaseId: lease.leaseId,
        seq: entry.seq,
        cardId: entry.cardId,
        outcome: "reviewed_elsewhere",
        httpStatus: 409,
        serverRevision: serverCard.revision,
        leasedCardRevision: leasedCard.cardRevision,
        expectedCardRevision: entry.expectedCardRevision,
        serverLastReviewedAtMs: serverCard.lastServerReviewedAtMs,
        reason: `Card ${entry.cardId} was reviewed elsewhere (serverRevision=${serverCard.revision}, leasedRevision=${leasedCard.cardRevision}, expected=${entry.expectedCardRevision}).`,
      });
      continue;
    }

    const clampedFromEasy = entry.rating === "easy";
    const effectiveRating: OfflineEffectiveRating = clampedFromEasy ? "good" : entry.rating;
    const nextSnapshot = scheduleServerReceiptFsrs(serverCard, effectiveRating, serverReceiptAtMs);
    const strippedClientFlags = detectStrippedClientFlags(entry);

    const receipt: OfflineSettledReceipt = {
      leaseId: lease.leaseId,
      seq: entry.seq,
      cardId: entry.cardId,
      rawRating: entry.rating,
      effectiveRating,
      clampedFromEasy,
      authorityClock: "server_receipt",
      effectiveReviewedAtMs: serverReceiptAtMs,
      delayedCheckMinted: false,
      allowMasteryPromotion: false,
      transferVerified: false,
      strippedClientFlags,
      previousRevision: serverCard.revision,
      newRevision: nextSnapshot.revision,
      nextSnapshot,
    };

    workingCards[entry.cardId] = nextSnapshot;
    workingLedger[idempotencyKey] = {
      leaseId: lease.leaseId,
      seq: entry.seq,
      payloadFingerprint,
      receipt: cloneLedgerEntry({
        leaseId: lease.leaseId,
        seq: entry.seq,
        payloadFingerprint,
        receipt,
      }).receipt,
    };
    settledCount += 1;

    results.push({
      leaseId: lease.leaseId,
      seq: entry.seq,
      cardId: entry.cardId,
      outcome: "settled",
      httpStatus: 200,
      payloadFingerprint,
      effectiveRating,
      clampedFromEasy,
      authorityClock: "server_receipt",
      effectiveReviewedAtMs: serverReceiptAtMs,
      delayedCheckMinted: false,
      allowMasteryPromotion: false,
      transferVerified: false,
      receipt,
    });
  }

  return {
    ok: true,
    leaseStatus: "active",
    serverReceiptAtMs,
    settledCount,
    replayedCount,
    conflictCount,
    results,
    updatedServerCards: workingCards,
    nextProcessedLedger: workingLedger,
  };
}
