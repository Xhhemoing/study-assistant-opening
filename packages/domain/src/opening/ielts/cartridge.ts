import { z } from "zod";
import { cloneCartridgeData } from "../cartridges/clone-cartridge-data";
import {
  restoreContinuityState,
  type CartridgeManifest,
  type CartridgeResumeSummary,
  type CartridgeValidationResult,
  type ContinuityCartridge,
} from "../cartridges/types";
import { countEnglishWords } from "./rubric";
import { classifySpeakingPace, hasVerifiedSpeakingRetelling } from "./speaking";
import { validateWritingRubricReceipt } from "./transfer";
import {
  IELTS_CARTRIDGE_ID,
  IELTS_CARTRIDGE_VERSION,
  isDenseIeltsArray,
  isNonBlankIeltsString as isNonBlankString,
  type IeltsRubricReceipt,
  type IeltsSpeakingFeedbackReceipt,
  type IeltsSpeakingPaceStatus,
  type IeltsSpeakingSignalKey,
} from "./types";

export const IELTS_CONTINUITY_SCHEMA_VERSION = 1 as const;

export const IELTS_REQUIREMENT_KEYS = [
  "ielts.writing.draft1-diagnostic",
  "ielts.writing.draft2-verified-transfer",
  "ielts.speaking.part3-verified-retelling",
] as const;

export type IeltsRequirementKey = (typeof IELTS_REQUIREMENT_KEYS)[number];

export type IeltsContinuityStage =
  | "writing_draft1"
  | "writing_draft2"
  | "speaking_part3"
  | "completed";

export type IeltsContinuityState = {
  readonly schemaVersion: typeof IELTS_CONTINUITY_SCHEMA_VERSION;
  readonly cartridgeId: typeof IELTS_CARTRIDGE_ID;
  readonly promptId: string;
  readonly activeStage: IeltsContinuityStage;
  readonly draft1Id: string | null;
  readonly draft2Receipt: IeltsRubricReceipt | null;
  readonly speakingReceipt: IeltsSpeakingFeedbackReceipt | null;
  readonly updatedAt: string;
};

export const IELTS_CARTRIDGE_MANIFEST: CartridgeManifest = Object.freeze({
  id: IELTS_CARTRIDGE_ID,
  version: IELTS_CARTRIDGE_VERSION,
  domain: "ielts",
  title: "IELTS Writing Task 2 & Speaking Part 3 Transfer",
  level: "L1_CONTINUITY",
});

const SPEAKING_PACE_STATUSES: ReadonlySet<IeltsSpeakingPaceStatus> = new Set([
  "invalid_duration",
  "too_short",
  "on_target",
  "over_time",
]);

const SPEAKING_SIGNAL_KEYS: readonly IeltsSpeakingSignalKey[] = [
  "fluencyCohesion",
  "lexicalTransfer",
  "syntacticVariety",
  "durationCompliance",
];

const SPEAKING_SIGNAL_RATINGS: ReadonlySet<string> = new Set([
  "strong",
  "developing",
  "needs_work",
]);

const ieltsContinuityStateSchema = z
  .object({
    schemaVersion: z.literal(IELTS_CONTINUITY_SCHEMA_VERSION),
    cartridgeId: z.literal(IELTS_CARTRIDGE_ID),
    promptId: z.string().trim().min(1).max(128),
    activeStage: z.enum(["writing_draft1", "writing_draft2", "speaking_part3", "completed"]),
    draft1Id: z.string().trim().min(1).max(128).nullable(),
    draft2Receipt: z.unknown().nullable(),
    speakingReceipt: z.unknown().nullable(),
    updatedAt: z
      .string()
      .refine((value) => value.trim().length > 0 && !Number.isNaN(Date.parse(value)), {
        message: "updatedAt must be a valid ISO timestamp",
      }),
  })
  .strict();

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function validateSpeakingReceipt(
  rawReceipt: unknown,
  expectedPromptId: string,
  draft2Receipt: IeltsRubricReceipt | null,
): readonly string[] {
  const issues: string[] = [];
  if (!isPlainRecord(rawReceipt)) {
    return ["speakingReceipt must be a plain object"];
  }

  if (!isNonBlankString(rawReceipt.receiptId)) issues.push("speakingReceipt.receiptId must be a non-blank string");
  if (rawReceipt.cartridgeId !== IELTS_CARTRIDGE_ID) issues.push("speakingReceipt.cartridgeId mismatch");
  if (!isNonBlankString(rawReceipt.seedId)) issues.push("speakingReceipt.seedId must be a non-blank string");
  if (rawReceipt.sourcePromptId !== expectedPromptId) {
    issues.push("speakingReceipt.sourcePromptId must match continuity promptId");
  }
  if (typeof rawReceipt.sourceTranscript !== "string") {
    issues.push("speakingReceipt.sourceTranscript must be a string");
  }
  if (typeof rawReceipt.assisted !== "boolean") issues.push("speakingReceipt.assisted must be a boolean");
  if (rawReceipt.taskMode !== "speaking_part3") issues.push("speakingReceipt.taskMode must be speaking_part3");
  if (rawReceipt.feedbackMode !== "transcript_practice_feedback") {
    issues.push("speakingReceipt.feedbackMode must be transcript_practice_feedback");
  }
  if (rawReceipt.pronunciationAssessed !== false) {
    issues.push("speakingReceipt.pronunciationAssessed must be false");
  }
  if (!isNonBlankString(rawReceipt.assessmentScopeNote)) {
    issues.push("speakingReceipt.assessmentScopeNote must be a non-blank string");
  }
  if (
    rawReceipt.epistemicStatus !== "practice_feedback" &&
    rawReceipt.epistemicStatus !== "rubric_verified_evidence"
  ) {
    issues.push("speakingReceipt.epistemicStatus is invalid");
  }
  if (typeof rawReceipt.countsTowardMastery !== "boolean") {
    issues.push("speakingReceipt.countsTowardMastery must be a boolean");
  }
  if (typeof rawReceipt.masteryQualified !== "boolean") {
    issues.push("speakingReceipt.masteryQualified must be a boolean");
  }
  if (!isNonBlankString(rawReceipt.epistemicReason)) {
    issues.push("speakingReceipt.epistemicReason must be a non-blank string");
  }
  if (
    typeof rawReceipt.wordCount !== "number" ||
    !Number.isSafeInteger(rawReceipt.wordCount) ||
    rawReceipt.wordCount < 0
  ) {
    issues.push("speakingReceipt.wordCount must be a non-negative integer");
  }
  if (
    rawReceipt.durationSeconds !== null &&
    (typeof rawReceipt.durationSeconds !== "number" ||
      !Number.isFinite(rawReceipt.durationSeconds) ||
      rawReceipt.durationSeconds <= 0)
  ) {
    issues.push("speakingReceipt.durationSeconds must be null or a positive number");
  }
  if (
    typeof rawReceipt.paceStatus !== "string" ||
    !SPEAKING_PACE_STATUSES.has(rawReceipt.paceStatus as IeltsSpeakingPaceStatus)
  ) {
    issues.push("speakingReceipt.paceStatus is invalid");
  }
  if (!isDenseIeltsArray(rawReceipt.transferredCollocations, isNonBlankString)) {
    issues.push("speakingReceipt.transferredCollocations must be a string array");
  }
  if (!isDenseIeltsArray(rawReceipt.pendingCollocations, isNonBlankString)) {
    issues.push("speakingReceipt.pendingCollocations must be a string array");
  }
  if (!isDenseIeltsArray(rawReceipt.memorizedTemplateHits, isPlainRecord)) {
    issues.push("speakingReceipt.memorizedTemplateHits must be a dense array of objects");
  }
  if (!isNonBlankString(rawReceipt.createdAt)) {
    issues.push("speakingReceipt.createdAt must be a non-blank string");
  }

  if (rawReceipt.evaluationContext !== undefined) {
    if (!isPlainRecord(rawReceipt.evaluationContext)) {
      issues.push("speakingReceipt.evaluationContext must be a plain object");
    } else {
      const tw = rawReceipt.evaluationContext.timeWindowSeconds;
      if (!isPlainRecord(tw) || tw.min !== 60 || tw.max !== 90) {
        issues.push("speakingReceipt.evaluationContext.timeWindowSeconds must be 60..90");
      }
      if (typeof rawReceipt.evaluationContext.writingReceiptEligible !== "boolean") {
        issues.push("speakingReceipt.evaluationContext.writingReceiptEligible must be a boolean");
      }
    }
  }

  if (!isPlainRecord(rawReceipt.transcriptSignals)) {
    issues.push("speakingReceipt.transcriptSignals must be a plain object");
  } else {
    for (const key of SPEAKING_SIGNAL_KEYS) {
      const signal = rawReceipt.transcriptSignals[key];
      if (
        !isPlainRecord(signal) ||
        signal.key !== key ||
        !isNonBlankString(signal.label) ||
        typeof signal.rating !== "string" ||
        !SPEAKING_SIGNAL_RATINGS.has(signal.rating) ||
        !isNonBlankString(signal.note)
      ) {
        issues.push(`speakingReceipt.transcriptSignals.${key} is invalid`);
      }
    }
  }

  if (!isDenseIeltsArray(rawReceipt.evidenceQuotes, isPlainRecord)) {
    issues.push("speakingReceipt.evidenceQuotes must be a dense array of objects");
  } else if (typeof rawReceipt.sourceTranscript === "string") {
    const transcript = rawReceipt.sourceTranscript;
    for (const [index, quote] of rawReceipt.evidenceQuotes.entries()) {
      if (
        !isNonBlankString(quote.id) ||
        typeof quote.signal !== "string" ||
        !SPEAKING_SIGNAL_KEYS.includes(quote.signal as IeltsSpeakingSignalKey) ||
        !isNonBlankString(quote.quote) ||
        typeof quote.startOffset !== "number" ||
        typeof quote.endOffset !== "number" ||
        !Number.isSafeInteger(quote.startOffset) ||
        !Number.isSafeInteger(quote.endOffset) ||
        quote.startOffset < 0 ||
        quote.endOffset <= quote.startOffset ||
        quote.endOffset > transcript.length ||
        transcript.slice(quote.startOffset, quote.endOffset) !== quote.quote ||
        !isNonBlankString(quote.diagnosis) ||
        !isNonBlankString(quote.upgradeRewrite)
      ) {
        issues.push(`speakingReceipt.evidenceQuotes[${index}] is invalid or ungrounded`);
      }
    }
  }

  if (issues.length > 0) return issues;

  const receipt = rawReceipt as IeltsSpeakingFeedbackReceipt;
  const computedWords = countEnglishWords(receipt.sourceTranscript);
  if (computedWords !== receipt.wordCount) {
    issues.push("speakingReceipt.wordCount does not match sourceTranscript");
  }

  const timeWindow = receipt.evaluationContext?.timeWindowSeconds ?? { min: 60, max: 90 };
  const expectedPaceStatus = classifySpeakingPace(receipt.durationSeconds, timeWindow);
  if (receipt.paceStatus !== expectedPaceStatus) {
    issues.push("speakingReceipt.paceStatus does not match durationSeconds and timeWindowSeconds");
  }

  const claimsVerified =
    receipt.epistemicStatus === "rubric_verified_evidence" ||
    receipt.countsTowardMastery ||
    receipt.masteryQualified;

  if (claimsVerified) {
    if (
      receipt.epistemicStatus !== "rubric_verified_evidence" ||
      receipt.countsTowardMastery !== true ||
      receipt.masteryQualified !== true
    ) {
      issues.push("speakingReceipt verified mastery flags are inconsistent");
    }
    const context = receipt.evaluationContext;
    if (context?.writingReceiptEligible !== true) {
      issues.push("speakingReceipt requires evaluationContext.writingReceiptEligible === true for mastery");
    }
    if (!draft2Receipt?.masteryQualified) {
      issues.push("speakingReceipt requires a verified Writing draft2Receipt prerequisite in continuity state");
    } else if (context?.writingReceiptEligible === true && !hasVerifiedSpeakingRetelling(
      receipt,
      [...receipt.transferredCollocations, ...receipt.pendingCollocations],
      context,
    )) {
      issues.push("speakingReceipt did not reproduce verified collocation transfer and mastery from sourceTranscript");
    }
  } else if (
    receipt.epistemicStatus !== "practice_feedback" ||
    receipt.countsTowardMastery !== false ||
    receipt.masteryQualified !== false
  ) {
    issues.push("speakingReceipt practice feedback must not claim mastery");
  }

  return issues;
}

export function createInitialIeltsContinuityState(
  promptId: string,
  updatedAt: string,
  options?: { readonly draft1Id?: string | null },
): IeltsContinuityState {
  const trimmedPromptId = promptId.trim();
  const trimmedDraft1Id = options?.draft1Id?.trim() || null;
  return {
    schemaVersion: IELTS_CONTINUITY_SCHEMA_VERSION,
    cartridgeId: IELTS_CARTRIDGE_ID,
    promptId: trimmedPromptId,
    activeStage: trimmedDraft1Id ? "writing_draft2" : "writing_draft1",
    draft1Id: trimmedDraft1Id,
    draft2Receipt: null,
    speakingReceipt: null,
    updatedAt,
  };
}

export function parseIeltsContinuityState(
  raw: unknown,
  options?: { readonly promptStatement?: string },
): CartridgeValidationResult<IeltsContinuityState> {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return { ok: false, issues: ["state_not_json"] };
    }
  }
  try {
    value = cloneCartridgeData(value);
  } catch {
    return { ok: false, issues: ["state_not_inspectable"] };
  }

  const parsed = ieltsContinuityStateSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    };
  }

  const issues: string[] = [];
  let validatedDraft2Receipt: IeltsRubricReceipt | null = null;
  if (parsed.data.draft2Receipt !== null) {
    const writingResult = validateWritingRubricReceipt(parsed.data.draft2Receipt, {
      expectedPromptId: parsed.data.promptId,
      promptStatement: options?.promptStatement,
    });
    if (!writingResult.ok) {
      issues.push(...writingResult.issues.map((issue) => `draft2Receipt: ${issue}`));
    } else {
      validatedDraft2Receipt = writingResult.receipt;
    }
  }

  let validatedSpeakingReceipt: IeltsSpeakingFeedbackReceipt | null = null;
  if (parsed.data.speakingReceipt !== null) {
    const speakingIssues = validateSpeakingReceipt(
      parsed.data.speakingReceipt,
      parsed.data.promptId,
      validatedDraft2Receipt,
    );
    if (speakingIssues.length > 0) {
      issues.push(...speakingIssues);
    } else {
      validatedSpeakingReceipt = parsed.data.speakingReceipt as IeltsSpeakingFeedbackReceipt;
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    value: {
      schemaVersion: parsed.data.schemaVersion,
      cartridgeId: parsed.data.cartridgeId,
      promptId: parsed.data.promptId,
      activeStage: parsed.data.activeStage,
      draft1Id: parsed.data.draft1Id,
      draft2Receipt: validatedDraft2Receipt,
      speakingReceipt: validatedSpeakingReceipt,
      updatedAt: parsed.data.updatedAt,
    },
  };
}

export function serializeIeltsContinuityState(state: IeltsContinuityState): string {
  const parsed = parseIeltsContinuityState(state);
  if (!parsed.ok) {
    throw new TypeError(`Invalid IELTS continuity state: ${parsed.issues.join("; ")}`);
  }
  return JSON.stringify(parsed.value);
}

export function buildIeltsResumeSummary(raw: unknown): CartridgeResumeSummary {
  const state = restoreContinuityState(parseIeltsContinuityState, raw);
  const draft1Done = state.draft1Id !== null || state.draft2Receipt !== null;
  const writingVerified = state.draft2Receipt?.masteryQualified === true;
  const speakingVerified = state.speakingReceipt?.masteryQualified === true;

  const completions: readonly [IeltsRequirementKey, boolean][] = [
    ["ielts.writing.draft1-diagnostic", draft1Done],
    ["ielts.writing.draft2-verified-transfer", writingVerified],
    ["ielts.speaking.part3-verified-retelling", speakingVerified],
  ];
  const completedSteps = completions.filter(([, done]) => done).length;
  const nextRequirementKey = completions.find(([, done]) => !done)?.[0] ?? null;

  let headline: string;
  if (nextRequirementKey === "ielts.writing.draft1-diagnostic") {
    headline = "雅思写作与口语迁移：待完成一稿诊断（0/3）";
  } else if (nextRequirementKey === "ielts.writing.draft2-verified-transfer") {
    headline = `雅思写作与口语迁移：已完成 ${completedSteps}/3，继续独立二稿改写与跨稿核验`;
  } else if (nextRequirementKey === "ielts.speaking.part3-verified-retelling") {
    headline = `雅思写作与口语迁移：已完成 ${completedSteps}/3，继续口语 Part 3 限时迁移复述`;
  } else {
    headline = "雅思写作与口语迁移：已完成全部 3/3 个核心阶段，可进入新题巩固";
  }

  return {
    cartridgeId: IELTS_CARTRIDGE_ID,
    cartridgeVersion: IELTS_CARTRIDGE_VERSION,
    headline,
    completedSteps,
    totalSteps: IELTS_REQUIREMENT_KEYS.length,
    nextRequirementKey,
  };
}

export function createIeltsWritingSpeakingCartridge(): ContinuityCartridge<IeltsContinuityState> {
  return {
    manifest: IELTS_CARTRIDGE_MANIFEST,
    serializeContinuityState: serializeIeltsContinuityState,
    parseContinuityState: parseIeltsContinuityState,
    buildResumeSummary: buildIeltsResumeSummary,
  };
}

export const ieltsWritingSpeakingCartridge: ContinuityCartridge<IeltsContinuityState> =
  createIeltsWritingSpeakingCartridge();
