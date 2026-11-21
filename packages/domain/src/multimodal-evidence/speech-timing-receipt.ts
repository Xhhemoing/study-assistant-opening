import type {
  MappedSpeechWordToken,
  MediaBudgetRejectionReason,
  RawAudioDisposition,
  RawAudioRetentionPolicyDecision,
  RawAudioRetentionPolicyInput,
  SpeechDisfluencyKind,
  SpeechPauseEvent,
  SpeechTimingReceipt,
  SpeechTimingReceiptInput,
  SpeechWordClock,
  VadVoicedSegment,
} from "./types";

export const DEFAULT_MINOR_HESITATION_MS = 800;
export const DEFAULT_BREAKDOWN_HESITATION_MS = 1_500;
export const RAW_AUDIO_HARD_RETENTION_CEILING_MS = 24 * 3_600_000;

const DURATION_EPSILON_MS = 1e-6;
const SENTENCE_TERMINAL_PUNCT_RE = /[.?!。？！]+$/u;
const FALSE_START_RE = /^[\p{L}\p{N}]+-$/u;

// ---------------------------------------------------------------------------
// Pure Browser-Safe FIPS 180-4 SHA-256 Digest Helper (zero node:crypto)
// ---------------------------------------------------------------------------

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const SHA256_INIT = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
] as const;

const rotr = (value: number, bits: number): number =>
  (value >>> bits) | (value << (32 - bits));

export function sha256HexUtf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const bitLen = bytes.length * 8;
  const paddedLen = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;

  const view = new DataView(padded.buffer);
  const highBits = Math.floor(bitLen / 0x1_0000_0000);
  const lowBits = bitLen >>> 0;
  view.setUint32(paddedLen - 8, highBits, false);
  view.setUint32(paddedLen - 4, lowBits, false);

  const hash = Uint32Array.from(SHA256_INIT);
  const w = new Uint32Array(64);

  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = [
      hash[0]!, hash[1]!, hash[2]!, hash[3]!,
      hash[4]!, hash[5]!, hash[6]!, hash[7]!,
    ];

    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[i]! + w[i]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    hash[0] = (hash[0]! + a) >>> 0;
    hash[1] = (hash[1]! + b) >>> 0;
    hash[2] = (hash[2]! + c) >>> 0;
    hash[3] = (hash[3]! + d) >>> 0;
    hash[4] = (hash[4]! + e) >>> 0;
    hash[5] = (hash[5]! + f) >>> 0;
    hash[6] = (hash[6]! + g) >>> 0;
    hash[7] = (hash[7]! + h) >>> 0;
  }

  return Array.from(hash, (word) => word.toString(16).padStart(8, "0")).join("");
}

// ---------------------------------------------------------------------------
// Pre-VAD Original PCM Clock Validation & Mapping
// ---------------------------------------------------------------------------

function validateVadSegments(
  segments: readonly VadVoicedSegment[],
  totalOriginalDurationMs: number,
): readonly VadVoicedSegment[] {
  if (!Number.isFinite(totalOriginalDurationMs) || totalOriginalDurationMs <= 0) {
    throw new RangeError(
      `totalOriginalDurationMs must be a finite positive number, got ${String(totalOriginalDurationMs)}.`,
    );
  }

  let prevOriginalEnd = 0;
  let prevStrippedEnd = 0;
  const validated: VadVoicedSegment[] = [];

  for (const [index, seg] of segments.entries()) {
    if (
      !Number.isFinite(seg.originalStartMs) ||
      !Number.isFinite(seg.originalEndMs) ||
      !Number.isFinite(seg.strippedStartMs) ||
      !Number.isFinite(seg.strippedEndMs)
    ) {
      throw new RangeError(`VAD segment[${index}] contains non-finite timestamps.`);
    }
    if (seg.originalStartMs < 0 || seg.originalEndMs > totalOriginalDurationMs) {
      throw new RangeError(
        `VAD segment[${index}] original bounds [${seg.originalStartMs}, ${seg.originalEndMs}] exceed [0, ${totalOriginalDurationMs}].`,
      );
    }
    if (seg.strippedStartMs < 0) {
      throw new RangeError(
        `VAD segment[${index}] strippedStartMs must be >= 0, got ${seg.strippedStartMs}.`,
      );
    }
    const origDur = seg.originalEndMs - seg.originalStartMs;
    const strippedDur = seg.strippedEndMs - seg.strippedStartMs;
    if (!(origDur > 0) || !(strippedDur > 0)) {
      throw new RangeError(
        `VAD segment[${index}] must have strictly positive duration.`,
      );
    }
    if (Math.abs(origDur - strippedDur) > DURATION_EPSILON_MS) {
      throw new RangeError(
        `VAD segment[${index}] duration mismatch: original=${origDur} vs stripped=${strippedDur}.`,
      );
    }
    if (index > 0 && seg.originalStartMs < prevOriginalEnd - DURATION_EPSILON_MS) {
      throw new RangeError(
        `VAD segment[${index}] overlaps or precedes previous originalEndMs (${seg.originalStartMs} < ${prevOriginalEnd}).`,
      );
    }
    if (index > 0 && seg.strippedStartMs < prevStrippedEnd - DURATION_EPSILON_MS) {
      throw new RangeError(
        `VAD segment[${index}] overlaps or precedes previous strippedEndMs (${seg.strippedStartMs} < ${prevStrippedEnd}).`,
      );
    }

    prevOriginalEnd = seg.originalEndMs;
    prevStrippedEnd = seg.strippedEndMs;
    validated.push(Object.freeze({ ...seg }));
  }

  return Object.freeze(validated);
}

/**
 * Maps a timestamp on the VAD-stripped concatenated clock back to exact pre-VAD
 * original PCM milliseconds.
 *
 * Boundary precision:
 * - `role === "start"` resolves boundary timestamps `t === seg[k].strippedEndMs === seg[k+1].strippedStartMs`
 *   to `seg[k+1].originalStartMs` (after the excised pause).
 * - `role === "end"` resolves boundary timestamps to `seg[k].originalEndMs` (before the excised pause).
 */
export function mapStrippedClockToOriginalPcmMs(
  strippedMs: number,
  segments: readonly VadVoicedSegment[],
  role: "start" | "end",
): { originalMs: number; segmentIndex: number } {
  if (segments.length === 0) {
    throw new RangeError("Cannot map vad_stripped timestamps when voicedSegments is empty.");
  }
  if (!Number.isFinite(strippedMs) || strippedMs < 0) {
    throw new RangeError(`Invalid strippedMs timestamp: ${String(strippedMs)}.`);
  }

  if (role === "start") {
    for (const [index, seg] of segments.entries()) {
      const isLast = index === segments.length - 1;
      const touchesNext =
        !isLast &&
        Math.abs(segments[index + 1]!.strippedStartMs - seg.strippedEndMs) <= DURATION_EPSILON_MS;
      const inUpper = touchesNext
        ? strippedMs < seg.strippedEndMs - DURATION_EPSILON_MS
        : strippedMs <= seg.strippedEndMs + DURATION_EPSILON_MS;
      if (strippedMs >= seg.strippedStartMs - DURATION_EPSILON_MS && inUpper) {
        const clampedOffset = Math.min(
          seg.originalEndMs - seg.originalStartMs,
          Math.max(0, strippedMs - seg.strippedStartMs),
        );
        return { originalMs: seg.originalStartMs + clampedOffset, segmentIndex: index };
      }
    }
  } else {
    for (let index = segments.length - 1; index >= 0; index -= 1) {
      const seg = segments[index]!;
      const isFirst = index === 0;
      const touchesPrev =
        !isFirst &&
        Math.abs(seg.strippedStartMs - segments[index - 1]!.strippedEndMs) <= DURATION_EPSILON_MS;
      const inLower = touchesPrev
        ? strippedMs > seg.strippedStartMs + DURATION_EPSILON_MS
        : strippedMs >= seg.strippedStartMs - DURATION_EPSILON_MS;
      if (inLower && strippedMs <= seg.strippedEndMs + DURATION_EPSILON_MS) {
        const clampedOffset = Math.min(
          seg.originalEndMs - seg.originalStartMs,
          Math.max(0, strippedMs - seg.strippedStartMs),
        );
        return { originalMs: seg.originalStartMs + clampedOffset, segmentIndex: index };
      }
    }
    // Exact match at first segment start if 0-length token at t === seg[0].strippedStartMs
    const first = segments[0]!;
    if (Math.abs(strippedMs - first.strippedStartMs) <= DURATION_EPSILON_MS) {
      return { originalMs: first.originalStartMs, segmentIndex: 0 };
    }
  }

  throw new RangeError(
    `Stripped timestamp ${strippedMs}ms falls outside any validated VAD voiced segment.`,
  );
}

function estimateEnglishSyllables(word: string): number {
  const letters = word.toLowerCase().replace(/[^a-z]/g, "");
  if (letters.length === 0) return 1;
  if (letters.length <= 3) return 1;
  const trimmedSilentE = letters.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/u, "");
  const normalized = trimmedSilentE.replace(/^y/u, "");
  const vowelGroups = normalized.match(/[aeiouy]{1,2}/g);
  return Math.max(1, vowelGroups ? vowelGroups.length : 1);
}

function normalizeLexicalWord(word: string): string {
  return word.toLowerCase().replace(/[^\p{L}\p{N}-]/gu, "");
}

/**
 * Reconstructs exact pre-VAD original PCM word timestamps and objective
 * IELTS Fluency & Coherence acoustic telemetry (`speechTimingReceipt`) without
 * storing or exposing raw audio bytes.
 */
export function issueSpeechTimingReceipt(
  input: SpeechTimingReceiptInput,
): SpeechTimingReceipt {
  if (typeof input.receiptId !== "string" || input.receiptId.trim().length === 0) {
    throw new RangeError("receiptId must be a non-empty string.");
  }

  const minorThreshold =
    input.minorHesitationThresholdMs ?? DEFAULT_MINOR_HESITATION_MS;
  const breakdownThreshold =
    input.breakdownHesitationThresholdMs ?? DEFAULT_BREAKDOWN_HESITATION_MS;
  if (
    !Number.isFinite(minorThreshold) ||
    minorThreshold <= 0 ||
    !Number.isFinite(breakdownThreshold) ||
    breakdownThreshold < minorThreshold
  ) {
    throw new RangeError(
      `Invalid hesitation thresholds: minor=${minorThreshold}, breakdown=${breakdownThreshold}.`,
    );
  }

  const issuedAtMs = input.issuedAtMs ?? 0;
  if (!Number.isFinite(issuedAtMs) || issuedAtMs < 0) {
    throw new RangeError(`issuedAtMs must be finite >= 0, got ${String(issuedAtMs)}.`);
  }

  const defaultClock: SpeechWordClock = input.defaultTokenClock ?? "vad_stripped";
  const speechRateMetric = input.speechRateMetric ?? "words_per_min";
  const segments = validateVadSegments(input.voicedSegments, input.totalOriginalDurationMs);

  const voicedDurationMs = segments.reduce(
    (sum, seg) => sum + (seg.originalEndMs - seg.originalStartMs),
    0,
  );
  const silenceDurationMs = Math.max(0, input.totalOriginalDurationMs - voicedDurationMs);

  const mappedWords: MappedSpeechWordToken[] = [];
  let prevOriginalStartMs = -Infinity;
  let prevLexicalWord = "";
  let totalSyllables = 0;
  let repairRepetitionCount = 0;
  let filledPauseCount = 0;

  for (const [index, token] of input.words.entries()) {
    const trimmedWord = token.word.trim();
    if (trimmedWord.length === 0) {
      throw new RangeError(`Word token at index ${index} must have non-empty word text.`);
    }
    if (!Number.isFinite(token.startMs) || !Number.isFinite(token.endMs) || token.endMs < token.startMs) {
      throw new RangeError(
        `Word token[${index}] "${trimmedWord}" has invalid interval [${token.startMs}, ${token.endMs}].`,
      );
    }

    const clock: SpeechWordClock = token.clock ?? defaultClock;
    let originalStartMs: number;
    let originalEndMs: number;

    if (clock === "original_pcm") {
      if (token.startMs < 0 || token.endMs > input.totalOriginalDurationMs) {
        throw new RangeError(
          `Word token[${index}] original_pcm bounds [${token.startMs}, ${token.endMs}] exceed [0, ${input.totalOriginalDurationMs}].`,
        );
      }
      originalStartMs = token.startMs;
      originalEndMs = token.endMs;
    } else {
      const mappedStart = mapStrippedClockToOriginalPcmMs(token.startMs, segments, "start");
      if (Math.abs(token.endMs - token.startMs) <= DURATION_EPSILON_MS) {
        originalStartMs = mappedStart.originalMs;
        originalEndMs = mappedStart.originalMs;
      } else {
        const mappedEnd = mapStrippedClockToOriginalPcmMs(token.endMs, segments, "end");
        let hasExcisedSilenceBetween = false;
        if (mappedStart.segmentIndex !== mappedEnd.segmentIndex) {
          const lowSeg = Math.min(mappedStart.segmentIndex, mappedEnd.segmentIndex);
          const highSeg = Math.max(mappedStart.segmentIndex, mappedEnd.segmentIndex);
          for (let k = lowSeg; k < highSeg; k += 1) {
            const leftSeg = segments[k]!;
            const rightSeg = segments[k + 1]!;
            if (rightSeg.originalStartMs - leftSeg.originalEndMs > DURATION_EPSILON_MS) {
              hasExcisedSilenceBetween = true;
              break;
            }
          }
        }

        if (hasExcisedSilenceBetween) {
          // Snap cross-seam jitter tokens to the single voiced segment owning the majority
          // of their stripped duration so excised pauses remain exposed between adjacent tokens.
          const lowSeg = Math.min(mappedStart.segmentIndex, mappedEnd.segmentIndex);
          const highSeg = Math.max(mappedStart.segmentIndex, mappedEnd.segmentIndex);
          let bestSegIndex = lowSeg;
          let bestOverlap = -1;
          for (let k = lowSeg; k <= highSeg; k += 1) {
            const seg = segments[k]!;
            const overlap = Math.max(
              0,
              Math.min(token.endMs, seg.strippedEndMs) - Math.max(token.startMs, seg.strippedStartMs),
            );
            if (overlap > bestOverlap) {
              bestOverlap = overlap;
              bestSegIndex = k;
            }
          }
          const snappedSeg = segments[bestSegIndex]!;
          const clampedStart = Math.max(token.startMs, snappedSeg.strippedStartMs);
          const clampedEnd = Math.min(token.endMs, snappedSeg.strippedEndMs);
          originalStartMs = snappedSeg.originalStartMs + (clampedStart - snappedSeg.strippedStartMs);
          originalEndMs = snappedSeg.originalStartMs + (clampedEnd - snappedSeg.strippedStartMs);
        } else {
          originalStartMs = mappedStart.originalMs;
          originalEndMs = mappedEnd.originalMs;
        }
      }
    }

    if (originalStartMs < prevOriginalStartMs - DURATION_EPSILON_MS) {
      throw new RangeError(
        `Word token[${index}] originalStartMs=${originalStartMs} precedes previous token (${prevOriginalStartMs}).`,
      );
    }
    prevOriginalStartMs = originalStartMs;

    const syllableCount =
      token.syllableCount !== undefined
        ? (() => {
            if (!Number.isFinite(token.syllableCount) || token.syllableCount < 0) {
              throw new RangeError(`Invalid syllableCount on word[${index}].`);
            }
            return token.syllableCount;
          })()
        : estimateEnglishSyllables(trimmedWord);
    totalSyllables += syllableCount;

    const lexical = normalizeLexicalWord(trimmedWord);
    const isAutoRepeat = lexical.length > 0 && lexical === prevLexicalWord;
    const isFalseStart = FALSE_START_RE.test(trimmedWord);
    if (lexical.length > 0) prevLexicalWord = lexical;

    let disfluencyKind: SpeechDisfluencyKind = token.disfluencyKind ?? "none";
    if (disfluencyKind === "none" && (token.isRepairOrRepetition === true || isAutoRepeat || isFalseStart)) {
      disfluencyKind = isAutoRepeat ? "repetition" : "self_repair";
    }
    const isRepairOrRepetition =
      token.isRepairOrRepetition === true ||
      disfluencyKind === "repetition" ||
      disfluencyKind === "self_repair";
    if (isRepairOrRepetition) repairRepetitionCount += 1;
    if (disfluencyKind === "filler") filledPauseCount += 1;

    const isSentenceBoundaryAfter =
      token.isSentenceBoundaryAfter ?? SENTENCE_TERMINAL_PUNCT_RE.test(trimmedWord);

    mappedWords.push(
      Object.freeze({
        index,
        word: trimmedWord,
        originalStartMs,
        originalEndMs,
        durationMs: Math.max(0, originalEndMs - originalStartMs),
        mappedFromClock: clock,
        isSentenceBoundaryAfter,
        syllableCount,
        isRepairOrRepetition,
        disfluencyKind,
      }),
    );
  }

  const midClauseHesitationPauses: SpeechPauseEvent[] = [];
  const sentenceBoundaryPauses: SpeechPauseEvent[] = [];
  const runWordCounts: number[] = [];

  let minorHesitationCount = 0;
  let breakdownPauseCount = 0;
  let currentRunWords = mappedWords.length > 0 ? 1 : 0;

  for (let i = 0; i + 1 < mappedWords.length; i += 1) {
    const current = mappedWords[i]!;
    const next = mappedWords[i + 1]!;
    const pauseDurationMs = Math.max(0, next.originalStartMs - current.originalEndMs);

    if (pauseDurationMs >= minorThreshold) {
      if (current.isSentenceBoundaryAfter) {
        sentenceBoundaryPauses.push(
          Object.freeze({
            afterWordIndex: i,
            beforeWordIndex: i + 1,
            startMs: current.originalEndMs,
            endMs: next.originalStartMs,
            durationMs: pauseDurationMs,
            kind: "sentence_boundary",
          }),
        );
      } else {
        const isBreakdown = pauseDurationMs >= breakdownThreshold;
        if (isBreakdown) {
          breakdownPauseCount += 1;
        } else {
          minorHesitationCount += 1;
        }
        midClauseHesitationPauses.push(
          Object.freeze({
            afterWordIndex: i,
            beforeWordIndex: i + 1,
            startMs: current.originalEndMs,
            endMs: next.originalStartMs,
            durationMs: pauseDurationMs,
            kind: isBreakdown ? "mid_clause_breakdown" : "mid_clause_minor",
          }),
        );
      }

      runWordCounts.push(currentRunWords);
      currentRunWords = 1;
    } else {
      currentRunWords += 1;
    }
  }

  if (mappedWords.length > 0) {
    runWordCounts.push(currentRunWords);
  }

  const wordCount = mappedWords.length;
  const totalMinutes = input.totalOriginalDurationMs / 60_000;
  const voicedMinutes = voicedDurationMs / 60_000;
  const speechRateWordsPerMin = totalMinutes > 0 ? wordCount / totalMinutes : 0;
  const speechRateSyllablesPerMin = totalMinutes > 0 ? totalSyllables / totalMinutes : 0;
  const articulationRateWordsPerMin = voicedMinutes > 0 ? wordCount / voicedMinutes : 0;
  const speechRateSylOrWordsPerMin =
    speechRateMetric === "syllables_per_min"
      ? speechRateSyllablesPerMin
      : speechRateWordsPerMin;

  const meanLengthOfRunWords =
    runWordCounts.length > 0
      ? runWordCounts.reduce((sum, count) => sum + count, 0) / runWordCounts.length
      : 0;

  const repairRepetitionRatio = wordCount > 0 ? repairRepetitionCount / wordCount : 0;
  const initialLatencyMs = mappedWords.length > 0 ? mappedWords[0]!.originalStartMs : input.totalOriginalDurationMs;
  const trailingSilenceMs =
    mappedWords.length > 0
      ? Math.max(0, input.totalOriginalDurationMs - mappedWords[mappedWords.length - 1]!.originalEndMs)
      : 0;

  const digestPayload = JSON.stringify({
    schemaVersion: 1,
    receiptId: input.receiptId,
    issuedAtMs,
    totalDurationMs: input.totalOriginalDurationMs,
    voicedDurationMs,
    silenceDurationMs,
    wordCount,
    syllableCount: totalSyllables,
    minorHesitationCount,
    breakdownPauseCount,
    sentenceBoundaryPauseCount: sentenceBoundaryPauses.length,
    meanLengthOfRunWords,
    repairRepetitionRatio,
    words: mappedWords.map((w) => [w.word, w.originalStartMs, w.originalEndMs, w.mappedFromClock]),
  });
  const integrityDigest = `sha256:${sha256HexUtf8(digestPayload)}`;

  return Object.freeze({
    schemaVersion: 1,
    receiptId: input.receiptId,
    issuedAtMs,
    totalDurationMs: input.totalOriginalDurationMs,
    voicedDurationMs,
    silenceDurationMs,
    initialLatencyMs,
    trailingSilenceMs,
    wordCount,
    syllableCount: totalSyllables,
    speechRateMetric,
    speechRateSylOrWordsPerMin,
    speechRateWordsPerMin,
    speechRateSyllablesPerMin,
    articulationRateWordsPerMin,
    minorHesitationCount,
    breakdownPauseCount,
    midClauseHesitationCount: midClauseHesitationPauses.length,
    sentenceBoundaryPauseCount: sentenceBoundaryPauses.length,
    midClauseHesitationPauses: Object.freeze(midClauseHesitationPauses),
    sentenceBoundaryPauses: Object.freeze(sentenceBoundaryPauses),
    meanLengthOfRunWords,
    runWordCounts: Object.freeze(runWordCounts),
    repairRepetitionCount,
    filledPauseCount,
    repairRepetitionRatio,
    words: Object.freeze(mappedWords),
    integrityDigest,
  });
}

// ---------------------------------------------------------------------------
// 0080 Media Budget Gate & Ephemeral Raw Audio Wipe Policy
// ---------------------------------------------------------------------------

function assertNonNegativeFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a finite non-negative number, got ${String(value)}.`);
  }
  return value;
}

/**
 * Enforces the `0080` media quota & recording duration gate BEFORE accepting an
 * audio recording/upload, and applies strict ephemeral raw audio purge policy:
 * - Default upon receipt issuance: `immediate_delete` (`retainRawAudio: false`, `deleteDeadlineMs: issuedAtMs`).
 * - Learner replay opt-in (`learnerOptInReplay: true`): hard physical sweep ceiling
 *   `<= 24h` (`issuedAtMs + 86_400_000`), flagging `sweep_due_immediately: true`
 *   whenever `nowMs >= deleteDeadlineMs`.
 */
export function evaluateRawAudioRetentionPolicy(
  input: RawAudioRetentionPolicyInput,
): RawAudioRetentionPolicyDecision {
  const mediaBytesUsed = assertNonNegativeFinite(input.mediaBytesUsed, "mediaBytesUsed");
  const recordingBytes = assertNonNegativeFinite(input.recordingBytes, "recordingBytes");
  const mediaQuotaBytes = assertNonNegativeFinite(input.mediaQuotaBytes, "mediaQuotaBytes");
  const durationMs = assertNonNegativeFinite(input.durationMs, "durationMs");
  const maxRecordingDurationMs = assertNonNegativeFinite(
    input.maxRecordingDurationMs,
    "maxRecordingDurationMs",
  );
  const issuedAtMs = assertNonNegativeFinite(input.issuedAtMs, "issuedAtMs");
  const nowMs = assertNonNegativeFinite(input.nowMs ?? issuedAtMs, "nowMs");

  let providerCap: number | null = null;
  if (input.providerMediaMaxInputBytes !== undefined && input.providerMediaMaxInputBytes !== null) {
    providerCap = assertNonNegativeFinite(
      input.providerMediaMaxInputBytes,
      "providerMediaMaxInputBytes",
    );
  }

  const rejectionReasons: MediaBudgetRejectionReason[] = [];
  if (mediaBytesUsed + recordingBytes > mediaQuotaBytes) {
    rejectionReasons.push("media_quota_exceeded");
  }
  if (providerCap !== null && recordingBytes > providerCap) {
    rejectionReasons.push("provider_media_max_bytes_exceeded");
  }
  if (durationMs > maxRecordingDurationMs) {
    rejectionReasons.push("recording_duration_exceeded");
  }

  const hardCeilingMs = issuedAtMs + RAW_AUDIO_HARD_RETENTION_CEILING_MS;

  if (rejectionReasons.length > 0) {
    return Object.freeze({
      schemaVersion: 1,
      accepted: false,
      disposition: "rejected_over_budget",
      retainRawAudio: false,
      deleteDeadlineMs: issuedAtMs,
      sweep_due_immediately: true,
      hardCeilingMs,
      hardCeilingApplied: false,
      remainingMediaBytesAfterUpload: Math.max(0, mediaQuotaBytes - mediaBytesUsed),
      rejectionReasons: Object.freeze(rejectionReasons),
    });
  }

  const remainingMediaBytesAfterUpload = Math.max(
    0,
    mediaQuotaBytes - (mediaBytesUsed + recordingBytes),
  );

  if (input.learnerOptInReplay !== true) {
    return Object.freeze({
      schemaVersion: 1,
      accepted: true,
      disposition: "immediate_delete",
      retainRawAudio: false,
      deleteDeadlineMs: issuedAtMs,
      sweep_due_immediately: true,
      hardCeilingMs,
      hardCeilingApplied: false,
      remainingMediaBytesAfterUpload,
      rejectionReasons: Object.freeze([]),
    });
  }

  const requestedUntilMs =
    input.requestedRetentionUntilMs !== undefined
      ? assertNonNegativeFinite(input.requestedRetentionUntilMs, "requestedRetentionUntilMs")
      : hardCeilingMs;

  const hardCeilingApplied = requestedUntilMs > hardCeilingMs;
  const deleteDeadlineMs = Math.max(issuedAtMs, Math.min(requestedUntilMs, hardCeilingMs));
  let sweepDue = nowMs >= deleteDeadlineMs;

  let disposition: RawAudioDisposition;
  let retainRawAudio: boolean;
  if (deleteDeadlineMs <= issuedAtMs) {
    disposition = "immediate_delete";
    retainRawAudio = false;
    sweepDue = true;
  } else if (sweepDue) {
    disposition = "sweep_expired";
    retainRawAudio = false;
  } else {
    disposition = "temporary_replay_retained";
    retainRawAudio = true;
  }

  return Object.freeze({
    schemaVersion: 1,
    accepted: true,
    disposition,
    retainRawAudio,
    deleteDeadlineMs,
    sweep_due_immediately: sweepDue,
    hardCeilingMs,
    hardCeilingApplied,
    remainingMediaBytesAfterUpload,
    rejectionReasons: Object.freeze([]),
  });
}
