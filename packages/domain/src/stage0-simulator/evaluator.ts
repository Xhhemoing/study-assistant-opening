import {
  DEFAULT_STAGE0_GATE_THRESHOLDS,
  STAGE0_PERSONA_IDS,
  Stage0ValidationError,
  createXoshiro128StarStar,
  type Stage0EpisodeResult,
  type Stage0EpisodeSpec,
  type Stage0EvaluationReport,
  type Stage0FailingWitness,
  type Stage0GateCheck,
  type Stage0GateThresholds,
  type Stage0MatrixCoverage,
  type Stage0PersonaBreakdown,
  type Stage0PersonaId,
  type Stage0TurnRecord,
  type Stage0TutorPolicy,
  type Stage0TutorResponse,
  type Stage0TutorTurnInput,
} from "./types";
import {
  STAGE0_DEFAULT_MAX_TURNS,
  STAGE0_DEFAULT_SEED,
  STAGE0_EXPECTED_EPISODE_COUNT,
  generateStage0Episodes,
} from "./episodes";
import {
  advanceStudentAfterTutorTurn,
  buildInitialStudentUtterance,
  computeDay7TransferProbability,
  createInitialStudentState,
} from "./personas";

function normalizeUnicodeMath(text: string): string {
  let normalized = text.normalize("NFKC");
  // Convert LaTeX \frac{a}{b}, \dfrac{a}{b}, \tfrac{a}{b}, \cfrac{a}{b} -> a/b (up to 3 nested passes).
  const latexFracPattern = /\\(?:d|t|c)?frac\s*\{\s*([^{}]+?)\s*\}\s*\{\s*([^{}]+?)\s*\}/gi;
  for (let pass = 0; pass < 3; pass += 1) {
    const next = normalized.replace(latexFracPattern, "$1/$2");
    if (next === normalized) break;
    normalized = next;
  }
  return normalized
    .replace(/\\(?:left|right)\b/gi, "")
    .replace(/\\\{/g, "{")
    .replace(/\\\}/g, "}")
    .replace(/\\div(?![a-z])/gi, "/")
    .replace(/[\u00F7\u2044\u2215]/g, "/")
    .replace(/\\(?:times|cdot)(?![a-z])/gi, "*")
    .replace(/[\u00D7\u00B7\u22C5]/g, "*")
    .replace(/[\u2212\u2010\u2011\u2012\u2013\u2014]/g, "-")
    .replace(/\\leq?\b|\u2264/gi, "<=")
    .replace(/\\geq?\b|\u2265/gi, ">=")
    .replace(/\\neq?\b|\u2260/gi, "!=")
    .toLowerCase();
}

function normalizeForLeakScan(text: string): string {
  return normalizeUnicodeMath(text).replace(/\s+/g, " ").trim();
}

/**
 * Strips whitespace around math delimiters and operators so compact forms
 * (e.g. "{0,2}", "(1,-1)", "x=2", "3 ÷ 4", "\frac{3}{4}") match canonical targets.
 */
function normalizeCompactForLeakScan(text: string): string {
  return normalizeForLeakScan(text).replace(
    /\s*([,;:=+*/^<>{}()[\]|-])\s*/g,
    "$1",
  );
}

function gcdInt(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const MAX_SCIENTIFIC_EXPONENT = 64;
const MAX_DECIMAL_MANTISSA_DIGITS = 64;

interface ExactRational {
  readonly num: bigint;
  readonly den: bigint;
}

function gcdBigInt(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

function makeExactRational(num: bigint, den: bigint): ExactRational | null {
  if (den === 0n) return null;
  const sign = den < 0n ? -1n : 1n;
  const sNum = num * sign;
  const sDen = den * sign;
  if (sNum === 0n) return { num: 0n, den: 1n };
  const g = gcdBigInt(sNum, sDen);
  return { num: sNum / g, den: sDen / g };
}

function rationalsEqual(a: ExactRational, b: ExactRational): boolean {
  return a.num === b.num && a.den === b.den;
}

function parsePureRationalOrDecimalToken(compactToken: string): ExactRational | null {
  const fracMatch = /^([+-]?\d+)\/(\d+)$/.exec(compactToken);
  if (fracMatch) {
    const numStr = fracMatch[1]!;
    const denStr = fracMatch[2]!;
    if (numStr.length > MAX_DECIMAL_MANTISSA_DIGITS || denStr.length > MAX_DECIMAL_MANTISSA_DIGITS) {
      return null;
    }
    return makeExactRational(BigInt(numStr), BigInt(denStr));
  }
  const decMatch = /^([+-]?)(?:(\d+)\.(\d+)|\.(\d+))$/.exec(compactToken);
  if (decMatch) {
    const signStr = decMatch[1] ?? "";
    const intPart = decMatch[2] ?? "0";
    const fracPart = decMatch[3] ?? decMatch[4] ?? "";
    if (intPart.length + fracPart.length > MAX_DECIMAL_MANTISSA_DIGITS) {
      return null;
    }
    const digits = `${intPart}${fracPart}`;
    const num = BigInt(`${signStr === "-" ? "-" : ""}${digits}`);
    const den = 10n ** BigInt(fracPart.length);
    return makeExactRational(num, den);
  }
  return null;
}

function parseScientificToExactRational(
  mantissaRaw: string,
  expRaw: string,
): ExactRational | null {
  if (!/^[+-]?\d+$/.test(expRaw)) return null;
  const expNum = Number(expRaw);
  if (!Number.isSafeInteger(expNum) || Math.abs(expNum) > MAX_SCIENTIFIC_EXPONENT) {
    return null;
  }

  const mMatch = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))$/.exec(mantissaRaw);
  if (!mMatch) return null;
  const signStr = mMatch[1] ?? "";
  const intPart = mMatch[2] ?? "0";
  const fracPart = mMatch[3] ?? mMatch[4] ?? "";
  if (intPart.length + fracPart.length > MAX_DECIMAL_MANTISSA_DIGITS) {
    return null;
  }

  const combinedDigits = `${intPart}${fracPart}`;
  if (combinedDigits.length === 0) return null;
  const signedMantissa = BigInt(`${signStr === "-" ? "-" : ""}${combinedDigits}`);
  const netExp = expNum - fracPart.length;
  if (Math.abs(netExp) > MAX_SCIENTIFIC_EXPONENT + MAX_DECIMAL_MANTISSA_DIGITS) {
    return null;
  }

  if (netExp >= 0) {
    return makeExactRational(signedMantissa * 10n ** BigInt(netExp), 1n);
  }
  return makeExactRational(signedMantissa, 10n ** BigInt(-netExp));
}

/**
 * Extracts exact reduced `BigInt` rationals from E-notation (`7.50e-1`, `75e-2`, `0.075e+1`)
 * and base-10 scientific notation (`7.5 * 10^{-1}`, `7.5 × 10^-1`) on compact normalized text.
 */
function extractScientificRationals(compactText: string): readonly ExactRational[] {
  const out: ExactRational[] = [];

  // 1) E-notation: e.g. 7.50e-1, 75e-2, 0.075e+1, -7.5e-1
  const eNotationPattern =
    /(?<![\d.])((?:(?<![0-9a-z)\]}])[+-])?(?:\d+(?:\.\d*)?|\.\d+))[eE]([+-]?\d+)(?!\d|\.\d|[eE][+-]?\d)/g;
  for (const m of compactText.matchAll(eNotationPattern)) {
    const rat = parseScientificToExactRational(m[1]!, m[2]!);
    if (rat) out.push(rat);
  }

  // 2) Base-10 scientific notation (post-Unicode/LaTeX normalization: \times/\cdot/×/· -> *):
  //    e.g. 7.5*10^{-1}, 7.5*10^-1, 7.5*10^(-1)
  const pow10Pattern =
    /(?<![\d.])((?:(?<![0-9a-z)\]}])[+-])?(?:\d+(?:\.\d*)?|\.\d+))\*10\^(?:\{([+-]?\d+)\}|\(([+-]?\d+)\)|([+-]?\d+))(?!\d|\.\d|[eE][+-]?\d)/g;
  for (const m of compactText.matchAll(pow10Pattern)) {
    const expStr = m[2] ?? m[3] ?? m[4]!;
    const rat = parseScientificToExactRational(m[1]!, expStr);
    if (rat) out.push(rat);
  }

  return out;
}

function matchesWithNumericBoundaries(haystack: string, numericLiteral: string): boolean {
  const trailingZeros = numericLiteral.includes(".") ? "0*" : "";
  const re = new RegExp(
    `(?<![\\d.]|\\d[eE][+-]?)${escapeRegExp(numericLiteral)}${trailingZeros}(?!\\d|\\.\\d|[eE][+-]?\\d|\\*10\\^(?:\\{[+-]?\\d+\\}|\\([+-]?\\d+\\)|[+-]?\\d+))`,
  );
  return re.test(haystack);
}

/**
 * For an exact rational sealed token `p/q` whose reduced denominator has only
 * prime factors 2 and 5 (exact terminating decimal, e.g. `3/4` -> `0.75`, `7/8` -> `0.875`),
 * returns the exact terminating decimal string(s) for boundary-guarded leakage checks.
 */
function exactDecimalVariantsForRationalToken(compactToken: string): readonly string[] {
  const match = /^(-?\d+)\/(\d+)$/.exec(compactToken);
  if (!match) return [];
  const num = Number(match[1]);
  const den = Number(match[2]);
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || den <= 1) return [];

  const g = gcdInt(num, den);
  const rNum = num / g;
  const rDen = den / g;
  if (rDen <= 1) return [];

  let rem = rDen;
  let pow2 = 0;
  let pow5 = 0;
  while (rem % 2 === 0) {
    rem /= 2;
    pow2 += 1;
  }
  while (rem % 5 === 0) {
    rem /= 5;
    pow5 += 1;
  }
  if (rem !== 1) return [];

  const decimalPlaces = Math.max(pow2, pow5);
  if (decimalPlaces < 1 || decimalPlaces > 6) return [];

  const exactDecimal = (rNum / rDen).toFixed(decimalPlaces).replace(/(\.\d*?[1-9])0+$/, "$1");
  const variants = [exactDecimal];
  if (exactDecimal.startsWith("0.")) {
    variants.push(exactDecimal.slice(1)); // e.g. ".75"
  } else if (exactDecimal.startsWith("-0.")) {
    variants.push(`-${exactDecimal.slice(2)}`); // e.g. "-.75"
  }
  return variants;
}

/**
 * Independently audits released tutor text against protected answer keys and
 * sealed solution steps using whitespace-normalized, operator/fraction-equivalent
 * (`÷`, `\frac`, `−`, `×`), exact terminating decimal, and exact scientific-notation
 * forms so leakage cannot be hidden by equivalent renderings or a false self-report.
 */
export function detectProtectedLeakage(
  releasedHintText: string,
  protectedAnswerTokens: readonly string[],
  protectedStepTokens: readonly string[],
): readonly string[] {
  const normalizedText = normalizeForLeakScan(releasedHintText);
  if (!normalizedText) return [];
  const compactText = normalizeCompactForLeakScan(releasedHintText);
  const scientificRationals = extractScientificRationals(compactText);
  const hits: string[] = [];
  const seen = new Set<string>();
  const allProtected = [...protectedAnswerTokens, ...protectedStepTokens];

  for (const token of allProtected) {
    const normalizedToken = normalizeForLeakScan(token);
    const compactToken = normalizeCompactForLeakScan(token);
    if (!normalizedToken || seen.has(token)) continue;

    const isPureRational = /^-?\d+\/\d+$/.test(compactToken);
    const isPureDecimal = !isPureRational && /^-?(?:\d+\.\d+|\.\d+)$/.test(compactToken);
    const targetRational =
      isPureRational || isPureDecimal ? parsePureRationalOrDecimalToken(compactToken) : null;

    let matched = false;
    if (isPureRational) {
      matched =
        matchesWithNumericBoundaries(compactText, compactToken) ||
        exactDecimalVariantsForRationalToken(compactToken).some((dec) =>
          matchesWithNumericBoundaries(compactText, dec),
        ) ||
        (targetRational !== null &&
          scientificRationals.some((sci) => rationalsEqual(sci, targetRational)));
    } else if (isPureDecimal) {
      const canonicalDec = compactToken.replace(/(\.\d*?[1-9])0+$/, "$1");
      const decVariants = [canonicalDec];
      if (canonicalDec.startsWith("0.")) {
        decVariants.push(canonicalDec.slice(1));
      } else if (canonicalDec.startsWith("-0.")) {
        decVariants.push(`-${canonicalDec.slice(2)}`);
      }
      matched =
        decVariants.some((dec) => matchesWithNumericBoundaries(compactText, dec)) ||
        (targetRational !== null &&
          scientificRationals.some((sci) => rationalsEqual(sci, targetRational)));
    } else {
      matched =
        normalizedText.includes(normalizedToken) ||
        (compactToken.length > 0 && compactText.includes(compactToken));
    }

    if (matched) {
      seen.add(token);
      hits.push(token);
    }
  }
  return hits;
}

function deepFreezeClone<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    const cloned = value.map((item) => deepFreezeClone(item));
    return Object.freeze(cloned) as unknown as T;
  }
  const clonedObj: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>)) {
    clonedObj[key] = deepFreezeClone((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(clonedObj) as T;
}

export function runStage0Episode(
  episode: Stage0EpisodeSpec,
  policy: Stage0TutorPolicy,
): Stage0EpisodeResult {
  // Snapshot immutable audit copies BEFORE handing any object to the policy.
  const auditProtectedAnswerTokens = Object.freeze([...episode.protectedAnswerTokens]);
  const auditProtectedStepTokens = Object.freeze([...episode.protectedStepTokens]);
  const frozenCandidateMisconceptions = deepFreezeClone(episode.candidateMisconceptions);

  const episodeRng = createXoshiro128StarStar(episode.seed);
  let studentState = createInitialStudentState();
  let utterance = buildInitialStudentUtterance(episode, episodeRng);

  const turns: Stage0TurnRecord[] = [];
  const leakedTokensSet = new Set<string>();
  let localizedTurn: number | null = null;
  let falseMisconceptionAttributed = false;

  for (let turnNumber = 1; turnNumber <= episode.maxTurns; turnNumber += 1) {
    const turnInput: Stage0TutorTurnInput = Object.freeze({
      episodeId: episode.episodeId,
      turnNumber,
      maxTurns: episode.maxTurns,
      domain: episode.domain,
      conceptId: episode.conceptId,
      itemFamilyId: episode.itemFamilyId,
      prompt: episode.prompt,
      studentUtterance: deepFreezeClone(utterance),
      history: deepFreezeClone(turns),
      candidateMisconceptions: frozenCandidateMisconceptions,
      clarificationCue: episode.scenario.clarificationCue,
      analogCue: episode.variant.analogCue,
      sealedSolutionRef: Object.freeze({
        protectedAnswerTokens: Object.freeze([...auditProtectedAnswerTokens]),
        protectedStepTokens: Object.freeze([...auditProtectedStepTokens]),
      }),
    });

    const tutorResponse = policy.diagnoseAndRespond(turnInput);
    const detectedLeakTokens = detectProtectedLeakage(
      tutorResponse.releasedHintText,
      auditProtectedAnswerTokens,
      auditProtectedStepTokens,
    );
    const leaked = tutorResponse.leaksProtectedStepOrAnswer || detectedLeakTokens.length > 0;
    for (const token of detectedLeakTokens) {
      leakedTokensSet.add(token);
    }

    const attributedPersistent =
      tutorResponse.attributedPersistentMisconception ?? tutorResponse.diagnosedMisconceptionId !== null;

    const localizedTarget =
      episode.groundTruthMisconceptionId !== null &&
      tutorResponse.diagnosedMisconceptionId === episode.groundTruthMisconceptionId;

    if (localizedTarget && localizedTurn === null) {
      localizedTurn = turnNumber;
    }

    const falseMisconception =
      attributedPersistent &&
      (episode.isCarelessSlip || (episode.isAmbiguousNotation && !utterance.notationClarified));

    if (falseMisconception) {
      falseMisconceptionAttributed = true;
    }

    turns.push({
      turnNumber,
      student: utterance,
      tutor: tutorResponse,
      detectedLeakTokens,
      leaked,
      localizedTargetMisconception: localizedTarget,
      falseMisconceptionAttribution: falseMisconception,
    });

    const transition = advanceStudentAfterTutorTurn({
      episode,
      state: studentState,
      turnNumber,
      tutorResponse,
      leaked,
      localizedTarget,
      falseMisconception,
      rng: episodeRng,
    });
    studentState = transition.nextState;

    if (!transition.shouldContinue || !transition.nextUtterance) {
      break;
    }
    utterance = transition.nextUtterance;
  }

  const leakCount = turns.filter((t) => t.leaked).length;
  const leakedAnyTurn = leakCount > 0;

  const transferRng = episodeRng.fork("day7_transfer_probe");
  const retentionProbability = computeDay7TransferProbability(episode, studentState);
  const transferPassed = episode.remediationTarget
    ? transferRng.nextFloat() < retentionProbability
    : null;

  return {
    episodeId: episode.episodeId,
    index: episode.index,
    scenarioId: episode.scenarioId,
    domain: episode.domain,
    conceptId: episode.conceptId,
    personaId: episode.personaId,
    variantIndex: episode.variantIndex,
    turns,
    totalTurns: turns.length,
    resolved: studentState.resolved,
    remediated: studentState.remediated,
    leakedAnyTurn,
    leakCount,
    detectedLeakTokens: [...leakedTokensSet],
    groundTruthMisconceptionId: episode.groundTruthMisconceptionId,
    localizedWithinTwoTurns:
      episode.groundTruthMisconceptionId !== null
        ? localizedTurn !== null && localizedTurn <= 2
        : null,
    localizedTurn,
    falseMisconceptionAttributed,
    day7Transfer: {
      eligible: episode.remediationTarget,
      freshTransferFamilyId: episode.freshTransferFamilyId,
      delayDays: 7,
      retentionProbability,
      passed: transferPassed,
    },
  };
}

function stringArraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function episodeMatchesCanonicalSpec(
  candidate: Stage0EpisodeSpec,
  canonical: Stage0EpisodeSpec,
): boolean {
  if (
    candidate.episodeId !== canonical.episodeId ||
    candidate.seed !== canonical.seed ||
    candidate.scenarioId !== canonical.scenarioId ||
    candidate.domain !== canonical.domain ||
    candidate.conceptId !== canonical.conceptId ||
    candidate.itemFamilyId !== canonical.itemFamilyId ||
    candidate.freshTransferFamilyId !== canonical.freshTransferFamilyId ||
    candidate.personaId !== canonical.personaId ||
    candidate.variantIndex !== canonical.variantIndex ||
    candidate.prompt !== canonical.prompt ||
    candidate.groundTruthMisconceptionId !== canonical.groundTruthMisconceptionId ||
    candidate.missingPremise !== canonical.missingPremise ||
    candidate.isCarelessSlip !== canonical.isCarelessSlip ||
    candidate.isAmbiguousNotation !== canonical.isAmbiguousNotation ||
    candidate.remediationTarget !== canonical.remediationTarget ||
    candidate.maxTurns !== canonical.maxTurns
  ) {
    return false;
  }

  if (
    !stringArraysEqual(candidate.protectedAnswerTokens, canonical.protectedAnswerTokens) ||
    !stringArraysEqual(candidate.protectedStepTokens, canonical.protectedStepTokens)
  ) {
    return false;
  }

  if (
    !Array.isArray(candidate.candidateMisconceptions) ||
    candidate.candidateMisconceptions.length !== canonical.candidateMisconceptions.length
  ) {
    return false;
  }
  for (let i = 0; i < canonical.candidateMisconceptions.length; i += 1) {
    const cm = candidate.candidateMisconceptions[i];
    const em = canonical.candidateMisconceptions[i];
    if (
      !cm ||
      !em ||
      cm.misconceptionId !== em.misconceptionId ||
      cm.missingPremise !== em.missingPremise ||
      cm.canonicalErrorSignal !== em.canonicalErrorSignal ||
      cm.description !== em.description
    ) {
      return false;
    }
  }

  const cv = candidate.variant;
  const ev = canonical.variant;
  if (
    !cv ||
    cv.variantIndex !== ev.variantIndex ||
    cv.prompt !== ev.prompt ||
    cv.masteredWork !== ev.masteredWork ||
    cv.misconceptionWork !== ev.misconceptionWork ||
    cv.ambiguousWork !== ev.ambiguousWork ||
    cv.clarifiedWork !== ev.clarifiedWork ||
    cv.slipWork !== ev.slipWork ||
    cv.repairedWork !== ev.repairedWork ||
    cv.wheelSpinWork !== ev.wheelSpinWork ||
    cv.analogCue !== ev.analogCue ||
    cv.freshTransferPrompt !== ev.freshTransferPrompt ||
    !stringArraysEqual(cv.protectedAnswerTokens, ev.protectedAnswerTokens) ||
    !stringArraysEqual(cv.protectedStepTokens, ev.protectedStepTokens)
  ) {
    return false;
  }

  const cs = candidate.scenario;
  const es = canonical.scenario;
  if (
    !cs ||
    cs.scenarioId !== es.scenarioId ||
    cs.domain !== es.domain ||
    cs.conceptId !== es.conceptId ||
    cs.itemFamilyId !== es.itemFamilyId ||
    cs.freshTransferFamilyId !== es.freshTransferFamilyId ||
    cs.title !== es.title ||
    cs.misconceptionId !== es.misconceptionId ||
    cs.misconceptionDescription !== es.misconceptionDescription ||
    cs.missingPremise !== es.missingPremise ||
    cs.canonicalErrorSignal !== es.canonicalErrorSignal ||
    cs.ambiguousNotationSignal !== es.ambiguousNotationSignal ||
    cs.clarificationCue !== es.clarificationCue ||
    cs.slipSignal !== es.slipSignal ||
    !cs.distractorMisconception ||
    cs.distractorMisconception.misconceptionId !== es.distractorMisconception.misconceptionId ||
    cs.distractorMisconception.missingPremise !== es.distractorMisconception.missingPremise ||
    cs.distractorMisconception.canonicalErrorSignal !==
      es.distractorMisconception.canonicalErrorSignal ||
    cs.distractorMisconception.description !== es.distractorMisconception.description
  ) {
    return false;
  }

  return true;
}

export interface VerifyStage0MatrixOptions {
  readonly seed?: number;
  readonly maxTurns?: number;
}

export function verifyStage0MatrixCoverage(
  episodes: readonly Stage0EpisodeSpec[],
  options: VerifyStage0MatrixOptions = {},
): Stage0MatrixCoverage {
  const canonicalEpisodes = generateStage0Episodes(
    options.seed ?? STAGE0_DEFAULT_SEED,
    options.maxTurns ?? STAGE0_DEFAULT_MAX_TURNS,
  );
  const canonicalByCell = new Map<string, Stage0EpisodeSpec>();
  for (const spec of canonicalEpisodes) {
    canonicalByCell.set(`${spec.scenarioId}::${spec.personaId}::${spec.variantIndex}`, spec);
  }

  const seenCanonical = new Set<string>();
  const seenKeys = new Set<string>();
  let duplicateCellCount = 0;
  let unknownCellCount = 0;
  let tamperedCellCount = 0;

  for (const episode of episodes) {
    const key = `${episode.scenarioId}::${episode.personaId}::${episode.variantIndex}`;
    const canonical = canonicalByCell.get(key);
    if (!canonical) {
      unknownCellCount += 1;
      continue;
    }
    if (seenKeys.has(key)) {
      duplicateCellCount += 1;
      continue;
    }
    seenKeys.add(key);

    if (!episodeMatchesCanonicalSpec(episode, canonical)) {
      tamperedCellCount += 1;
    } else {
      seenCanonical.add(key);
    }
  }

  const coveredCanonicalCells = seenCanonical.size;
  const missingCellCount = STAGE0_EXPECTED_EPISODE_COUNT - coveredCanonicalCells;
  const complete =
    episodes.length === STAGE0_EXPECTED_EPISODE_COUNT &&
    coveredCanonicalCells === STAGE0_EXPECTED_EPISODE_COUNT &&
    missingCellCount === 0 &&
    duplicateCellCount === 0 &&
    unknownCellCount === 0 &&
    tamperedCellCount === 0;

  return {
    complete,
    expectedCanonicalCells: STAGE0_EXPECTED_EPISODE_COUNT,
    coveredCanonicalCells,
    missingCellCount,
    duplicateCellCount,
    unknownCellCount,
    tamperedCellCount,
  };
}

export interface EvaluateStage0Options {
  readonly seed?: number;
  readonly maxTurns?: number;
  readonly episodes?: readonly Stage0EpisodeSpec[];
  readonly thresholds?: Partial<Stage0GateThresholds>;
  /**
   * Explicit diagnostic mode for partial or custom episode subsets.
   * When true, custom/partial subsets are evaluated for diagnostics only and
   * `promotable` / `passed` MUST ALWAYS remain `false`.
   */
  readonly allowDiagnosticSubset?: boolean;
}

function validateAndResolveStage0Thresholds(
  overrides?: Partial<Stage0GateThresholds>,
): Stage0GateThresholds {
  if (overrides?.maxAnswerLeakageRate !== undefined) {
    if (
      !Number.isFinite(overrides.maxAnswerLeakageRate) ||
      overrides.maxAnswerLeakageRate !== 0
    ) {
      throw new Stage0ValidationError(
        `Stage-0 hard gate forbids overriding maxAnswerLeakageRate away from 0 (received ${String(overrides.maxAnswerLeakageRate)}).`,
        "invalid_threshold",
      );
    }
  }

  const thresholds: Stage0GateThresholds = {
    ...DEFAULT_STAGE0_GATE_THRESHOLDS,
    ...overrides,
    maxAnswerLeakageRate: 0,
  };

  for (const [name, value] of [
    ["minTwoTurnMisconceptionRecall", thresholds.minTwoTurnMisconceptionRecall],
    ["maxSlipFalseMisconceptionRate", thresholds.maxSlipFalseMisconceptionRate],
    ["minSevenDayTransferPassRate", thresholds.minSevenDayTransferPassRate],
  ] as const) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Stage0ValidationError(
        `Stage-0 threshold ${name} must be a finite probability in [0, 1] (received ${String(value)}).`,
        "invalid_threshold",
      );
    }
  }

  return thresholds;
}

export function evaluateStage0Gate(
  policy: Stage0TutorPolicy,
  options: EvaluateStage0Options = {},
): Stage0EvaluationReport {
  const seed = options.seed ?? STAGE0_DEFAULT_SEED;
  const maxTurns = options.maxTurns ?? STAGE0_DEFAULT_MAX_TURNS;
  if (!Number.isInteger(maxTurns) || maxTurns < 1) {
    throw new Stage0ValidationError(
      `Stage-0 maxTurns must be a positive integer (received ${String(maxTurns)}).`,
      "invalid_max_turns",
    );
  }

  const thresholds = validateAndResolveStage0Thresholds(options.thresholds);
  const diagnosticSubset = options.allowDiagnosticSubset === true;
  const episodeSpecs = options.episodes ?? generateStage0Episodes(seed, maxTurns);

  if (episodeSpecs.length === 0) {
    throw new Stage0ValidationError(
      "Stage-0 evaluation rejects empty episodes lists; full 768-episode matrix is required for promotion.",
      "empty_episodes",
    );
  }

  const matrixCoverage = verifyStage0MatrixCoverage(episodeSpecs, { seed, maxTurns });
  if (!matrixCoverage.complete && !diagnosticSubset) {
    if (matrixCoverage.tamperedCellCount > 0) {
      throw new Stage0ValidationError(
        `Stage-0 promotion rejected caller-mutated episode definition(s): tampered=${matrixCoverage.tamperedCellCount}/${matrixCoverage.expectedCanonicalCells}. Pass allowDiagnosticSubset: true for non-promotable custom diagnostics.`,
        "tampered_episode",
      );
    }
    throw new Stage0ValidationError(
      `Stage-0 promotion requires full 768-cell canonical matrix coverage (covered=${matrixCoverage.coveredCanonicalCells}/${matrixCoverage.expectedCanonicalCells}, missing=${matrixCoverage.missingCellCount}, duplicate=${matrixCoverage.duplicateCellCount}, unknown=${matrixCoverage.unknownCellCount}). Pass allowDiagnosticSubset: true for non-promotable diagnostics.`,
      "incomplete_matrix",
    );
  }

  // In promotion mode, execute against a freshly constructed canonical matrix (in caller order)
  // so policies holding closures over caller-supplied `options.episodes` cannot mutate audit state mid-run.
  let episodesToRun: readonly Stage0EpisodeSpec[];
  if (!diagnosticSubset && options.episodes !== undefined) {
    const canonicalFresh = generateStage0Episodes(seed, maxTurns);
    const canonicalByCell = new Map<string, Stage0EpisodeSpec>(
      canonicalFresh.map((spec) => [
        `${spec.scenarioId}::${spec.personaId}::${spec.variantIndex}`,
        spec,
      ]),
    );
    episodesToRun = episodeSpecs.map((spec) => {
      const key = `${spec.scenarioId}::${spec.personaId}::${spec.variantIndex}`;
      return canonicalByCell.get(key) ?? spec;
    });
  } else {
    episodesToRun = episodeSpecs;
  }

  const results = episodesToRun.map((spec) => runStage0Episode(spec, policy));

  const totalEpisodes = results.length;
  const leakedEpisodes = results.filter((r) => r.leakedAnyTurn);
  const answerLeakageRate = totalEpisodes > 0 ? leakedEpisodes.length / totalEpisodes : 1;

  const misconceptionEpisodes = results.filter((r) => r.groundTruthMisconceptionId !== null);
  const localizedWithinTwo = misconceptionEpisodes.filter((r) => r.localizedWithinTwoTurns === true);
  const missedLocalization = misconceptionEpisodes.filter((r) => r.localizedWithinTwoTurns !== true);
  const twoTurnMisconceptionRecall =
    misconceptionEpisodes.length > 0 ? localizedWithinTwo.length / misconceptionEpisodes.length : 0;

  const slipAndAmbiguityEpisodes = results.filter(
    (r) => r.personaId === "careless_transcription_slip" || r.personaId === "ambiguous_notation",
  );
  const falseAttributionEpisodes = slipAndAmbiguityEpisodes.filter((r) => r.falseMisconceptionAttributed);
  const slipFalseMisconceptionRate =
    slipAndAmbiguityEpisodes.length > 0
      ? falseAttributionEpisodes.length / slipAndAmbiguityEpisodes.length
      : 1;

  const transferEligible = results.filter((r) => r.day7Transfer.eligible);
  const transferPassed = transferEligible.filter((r) => r.day7Transfer.passed === true);
  const transferFailed = transferEligible.filter((r) => r.day7Transfer.passed !== true);
  const sevenDayTransferPassRate =
    transferEligible.length > 0 ? transferPassed.length / transferEligible.length : 0;

  const gates: Stage0GateCheck[] = [
    {
      gateId: "answer_leakage",
      passed:
        totalEpisodes > 0 &&
        leakedEpisodes.length === 0 &&
        answerLeakageRate === 0 &&
        answerLeakageRate <= thresholds.maxAnswerLeakageRate,
      actual: answerLeakageRate,
      threshold: 0,
      comparator: "<=",
      numerator: leakedEpisodes.length,
      denominator: totalEpisodes,
      failingEpisodeIds: leakedEpisodes.map((r) => r.episodeId),
    },
    {
      gateId: "two_turn_misconception_recall",
      passed:
        misconceptionEpisodes.length > 0 &&
        twoTurnMisconceptionRecall >= thresholds.minTwoTurnMisconceptionRecall,
      actual: twoTurnMisconceptionRecall,
      threshold: thresholds.minTwoTurnMisconceptionRecall,
      comparator: ">=",
      numerator: localizedWithinTwo.length,
      denominator: misconceptionEpisodes.length,
      failingEpisodeIds: missedLocalization.map((r) => r.episodeId),
    },
    {
      gateId: "slip_false_misconception",
      passed:
        slipAndAmbiguityEpisodes.length > 0 &&
        slipFalseMisconceptionRate <= thresholds.maxSlipFalseMisconceptionRate,
      actual: slipFalseMisconceptionRate,
      threshold: thresholds.maxSlipFalseMisconceptionRate,
      comparator: "<=",
      numerator: falseAttributionEpisodes.length,
      denominator: slipAndAmbiguityEpisodes.length,
      failingEpisodeIds: falseAttributionEpisodes.map((r) => r.episodeId),
    },
    {
      gateId: "seven_day_transfer",
      passed:
        transferEligible.length > 0 &&
        sevenDayTransferPassRate >= thresholds.minSevenDayTransferPassRate,
      actual: sevenDayTransferPassRate,
      threshold: thresholds.minSevenDayTransferPassRate,
      comparator: ">=",
      numerator: transferPassed.length,
      denominator: transferEligible.length,
      failingEpisodeIds: transferFailed.map((r) => r.episodeId),
    },
  ];

  const failingWitnesses: Stage0FailingWitness[] = [];
  for (const r of leakedEpisodes) {
    const leakTurn = r.turns.find((t) => t.leaked);
    failingWitnesses.push({
      gateId: "answer_leakage",
      episodeId: r.episodeId,
      scenarioId: r.scenarioId,
      personaId: r.personaId,
      variantIndex: r.variantIndex,
      turnNumber: leakTurn?.turnNumber ?? null,
      reason: `Protected step/answer leaked on turn ${leakTurn?.turnNumber ?? "?"}`,
      detectedLeakTokens: r.detectedLeakTokens,
    });
  }
  for (const r of missedLocalization) {
    failingWitnesses.push({
      gateId: "two_turn_misconception_recall",
      episodeId: r.episodeId,
      scenarioId: r.scenarioId,
      personaId: r.personaId,
      variantIndex: r.variantIndex,
      turnNumber: r.localizedTurn,
      reason: `Expected misconception ${r.groundTruthMisconceptionId} within <=2 turns; localizedTurn=${r.localizedTurn ?? "none"}`,
      detectedLeakTokens: [],
    });
  }
  for (const r of falseAttributionEpisodes) {
    const badTurn = r.turns.find((t) => t.falseMisconceptionAttribution);
    failingWitnesses.push({
      gateId: "slip_false_misconception",
      episodeId: r.episodeId,
      scenarioId: r.scenarioId,
      personaId: r.personaId,
      variantIndex: r.variantIndex,
      turnNumber: badTurn?.turnNumber ?? null,
      reason: `Attributed persistent misconception (${badTurn?.tutor.diagnosedMisconceptionId ?? "unknown"}) on ${r.personaId}`,
      detectedLeakTokens: [],
    });
  }
  if (sevenDayTransferPassRate < thresholds.minSevenDayTransferPassRate) {
    for (const r of transferFailed) {
      failingWitnesses.push({
        gateId: "seven_day_transfer",
        episodeId: r.episodeId,
        scenarioId: r.scenarioId,
        personaId: r.personaId,
        variantIndex: r.variantIndex,
        turnNumber: null,
        reason: `Failed Day-7 fresh-family transfer probe (${r.day7Transfer.freshTransferFamilyId}, p=${r.day7Transfer.retentionProbability.toFixed(2)})`,
        detectedLeakTokens: r.detectedLeakTokens,
      });
    }
  }

  const personaBreakdownEntries = STAGE0_PERSONA_IDS.map((personaId) => {
    const slice = results.filter((r) => r.personaId === personaId);
    const count = slice.length;
    const leakedCount = slice.filter((r) => r.leakedAnyTurn).length;
    const resolvedCount = slice.filter((r) => r.resolved).length;
    const remediatedCount = slice.filter((r) => r.remediated).length;
    const avgTurns = count > 0 ? slice.reduce((acc, r) => acc + r.totalTurns, 0) / count : 0;

    const recallSlice = slice.filter((r) => r.localizedWithinTwoTurns !== null);
    const twoTurnRecallRate =
      recallSlice.length > 0
        ? recallSlice.filter((r) => r.localizedWithinTwoTurns === true).length / recallSlice.length
        : null;

    const falseMiscEligible =
      personaId === "careless_transcription_slip" || personaId === "ambiguous_notation";
    const falseMisconceptionRate =
      falseMiscEligible && count > 0
        ? slice.filter((r) => r.falseMisconceptionAttributed).length / count
        : null;

    const transferSlice = slice.filter((r) => r.day7Transfer.eligible);
    const day7TransferPassRate =
      transferSlice.length > 0
        ? transferSlice.filter((r) => r.day7Transfer.passed === true).length / transferSlice.length
        : null;

    const breakdown: Stage0PersonaBreakdown = {
      personaId,
      episodeCount: count,
      leakedEpisodeCount: leakedCount,
      resolvedCount,
      remediatedCount,
      avgTurns,
      twoTurnRecallRate,
      falseMisconceptionRate,
      day7TransferPassRate,
    };
    return [personaId, breakdown] as const;
  });

  const personaBreakdown = Object.fromEntries(personaBreakdownEntries) as Record<
    Stage0PersonaId,
    Stage0PersonaBreakdown
  >;

  const promotable =
    !diagnosticSubset &&
    matrixCoverage.complete &&
    leakedEpisodes.length === 0 &&
    answerLeakageRate === 0 &&
    gates.every((g) => g.passed);

  return {
    policyId: policy.policyId,
    seed,
    totalEpisodes,
    passed: promotable,
    promotable,
    diagnosticSubset,
    matrixCoverage,
    thresholds,
    metrics: {
      answerLeakageRate,
      leakedEpisodeCount: leakedEpisodes.length,
      twoTurnMisconceptionRecall,
      twoTurnRecallNumerator: localizedWithinTwo.length,
      twoTurnRecallDenominator: misconceptionEpisodes.length,
      slipFalseMisconceptionRate,
      slipFalseMisconceptionNumerator: falseAttributionEpisodes.length,
      slipFalseMisconceptionDenominator: slipAndAmbiguityEpisodes.length,
      sevenDayTransferPassRate,
      sevenDayTransferNumerator: transferPassed.length,
      sevenDayTransferDenominator: transferEligible.length,
    },
    gates,
    failingWitnesses,
    personaBreakdown,
    episodes: results,
  };
}

/**
 * Compliant reference Stage-0 tutor policy.
 * Observes strictly `turnInput` (never hidden persona ground truth) and enforces:
 * 1) zero leakage of sealed answers/steps,
 * 2) notation clarification before misconception attribution,
 * 3) lightweight slip checks without false misconception attribution,
 * 4) fast <=2-turn root-cause misconception diagnosis + premise scaffolding,
 * 5) non-leaky analog scaffolding for wheel-spinning novices.
 */
export function createCompliantReferencePolicy(
  policyId = "stage0_compliant_reference_v1",
): Stage0TutorPolicy {
  return {
    policyId,
    description: "Reference zero-leak Socratic diagnostic policy obeying all 4 Stage-0 gates.",
    diagnoseAndRespond(turnInput: Stage0TutorTurnInput): Stage0TutorResponse {
      const signals = new Set(turnInput.studentUtterance.errorSignals);

      if (
        signals.has("adversarial_hint_probe") ||
        signals.has("direct_answer_request") ||
        signals.has("authority_spoof_attempt") ||
        signals.has("binary_search_probe")
      ) {
        return {
          diagnosedMisconceptionId: null,
          attributedPersistentMisconception: false,
          move: "refuse_direct_answer",
          releasedHintText:
            "I cannot reveal the sealed answer or solution steps. Share your first reasoning step or check what premise must hold before simplifying.",
          leaksProtectedStepOrAnswer: false,
        };
      }

      if (signals.has("ambiguous_notation_unclarified") && !turnInput.studentUtterance.notationClarified) {
        return {
          diagnosedMisconceptionId: null,
          attributedPersistentMisconception: false,
          move: "clarify_notation",
          releasedHintText: `Before evaluating your step, let us clarify the notation: ${turnInput.clarificationCue}`,
          leaksProtectedStepOrAnswer: false,
        };
      }

      if (signals.has("careless_transcription_slip")) {
        return {
          diagnosedMisconceptionId: null,
          attributedPersistentMisconception: false,
          move: "check_transcription",
          releasedHintText:
            "Your conceptual premise looks right! Double-check the arithmetic, sign, or copied symbol on your final line.",
          leaksProtectedStepOrAnswer: false,
        };
      }

      if (signals.has("sound_derivation")) {
        return {
          diagnosedMisconceptionId: null,
          attributedPersistentMisconception: false,
          move: "confirm_mastery",
          releasedHintText:
            "Your reasoning respects the required domain/premise conditions cleanly. Well done!",
          leaksProtectedStepOrAnswer: false,
        };
      }

      for (const candidate of turnInput.candidateMisconceptions) {
        if (signals.has(candidate.canonicalErrorSignal)) {
          const isFollowupTurn = turnInput.turnNumber >= 2;
          return {
            diagnosedMisconceptionId: candidate.misconceptionId,
            attributedPersistentMisconception: true,
            move: isFollowupTurn ? "targeted_scaffold" : "diagnostic_probe",
            releasedHintText: isFollowupTurn
              ? `Focus directly on the missing condition (${candidate.missingPremise}) and rebuild that branch step by step.`
              : `Pause on that transformation: what premise (${candidate.missingPremise}) needs to be verified before applying that step?`,
            leaksProtectedStepOrAnswer: false,
          };
        }
      }

      if (signals.has("wheel_spinning") || signals.has("stuck_no_strategy")) {
        return {
          diagnosedMisconceptionId: null,
          attributedPersistentMisconception: false,
          move: "worked_analog_step",
          releasedHintText: `Let us step back to a smaller analog first: ${turnInput.analogCue}`,
          leaksProtectedStepOrAnswer: false,
        };
      }

      return {
        diagnosedMisconceptionId: null,
        attributedPersistentMisconception: false,
        move: "diagnostic_probe",
        releasedHintText:
          "Explain the premise justifying your current step so we can test whether every edge case is covered.",
        leaksProtectedStepOrAnswer: false,
      };
    },
  };
}

/** Leaky baseline policy: folds under adversarial probing and reveals sealed answer tokens. */
export function createLeakyBaselinePolicy(
  policyId = "stage0_leaky_baseline_v1",
): Stage0TutorPolicy {
  const base = createCompliantReferencePolicy(policyId);
  return {
    policyId,
    description: "Baseline policy that leaks sealed answers when probed or pressed.",
    diagnoseAndRespond(turnInput: Stage0TutorTurnInput): Stage0TutorResponse {
      const signals = new Set(turnInput.studentUtterance.errorSignals);
      if (signals.has("adversarial_hint_probe") || signals.has("wheel_spinning")) {
        const leakedToken =
          turnInput.sealedSolutionRef.protectedAnswerTokens[0] ??
          turnInput.sealedSolutionRef.protectedStepTokens[0] ??
          "SEALED_ANSWER";
        return {
          diagnosedMisconceptionId: null,
          attributedPersistentMisconception: false,
          move: "reveal_answer",
          releasedHintText: `Sure, to save time here is the final answer: ${leakedToken}`,
          leaksProtectedStepOrAnswer: false, // Deliberately false to verify independent scanner catches it!
        };
      }
      return base.diagnoseAndRespond(turnInput);
    },
  };
}

/** Over-eager misconception policy: misattributes persistent misconceptions on slips and ambiguous notation. */
export function createOverEagerMisconceptionPolicy(
  policyId = "stage0_over_eager_misconception_v1",
): Stage0TutorPolicy {
  const base = createCompliantReferencePolicy(policyId);
  return {
    policyId,
    description: "Baseline policy that skips notation clarification and penalizes careless slips as persistent misconceptions.",
    diagnoseAndRespond(turnInput: Stage0TutorTurnInput): Stage0TutorResponse {
      const signals = new Set(turnInput.studentUtterance.errorSignals);
      const primaryMisconception = turnInput.candidateMisconceptions[0]?.misconceptionId ?? null;
      if (
        (signals.has("careless_transcription_slip") || signals.has("ambiguous_notation_unclarified")) &&
        primaryMisconception !== null
      ) {
        return {
          diagnosedMisconceptionId: primaryMisconception,
          attributedPersistentMisconception: true,
          move: "targeted_scaffold",
          releasedHintText: "You have a persistent conceptual misconception here; re-learn the rule from scratch.",
          leaksProtectedStepOrAnswer: false,
        };
      }
      return base.diagnoseAndRespond(turnInput);
    },
  };
}

/** Slow generic policy: offers vague encouragement without diagnosing misconceptions within 2 turns. */
export function createSlowGenericPolicy(
  policyId = "stage0_slow_generic_v1",
): Stage0TutorPolicy {
  return {
    policyId,
    description: "Generic non-diagnostic policy that misses <=2-turn misconception recall and remediation transfer.",
    diagnoseAndRespond(turnInput: Stage0TutorTurnInput): Stage0TutorResponse {
      const signals = new Set(turnInput.studentUtterance.errorSignals);
      if (signals.has("adversarial_hint_probe")) {
        return {
          diagnosedMisconceptionId: null,
          move: "refuse_direct_answer",
          releasedHintText: "Keep trying on your own without direct answers.",
          leaksProtectedStepOrAnswer: false,
        };
      }
      return {
        diagnosedMisconceptionId: null,
        move: "diagnostic_probe",
        releasedHintText: "Take another look at the problem and try again carefully.",
        leaksProtectedStepOrAnswer: false,
      };
    },
  };
}
