import type {
  AbilitySlice,
  AssessmentMode,
  ErrorCause,
  ReviewGrade,
  StatusResult,
  StatusWord,
  SummaryMetric,
} from "@aistudy/contracts";
import { applyContextualRules, judge } from "./status-rules";

export const ASSESSMENT_VERSION = "assess-1";
export const ASSESSMENT_MODEL_VERSION = "rules-2";

export type EvidenceSource = "attempt" | "review";
export type AssessmentSlice = AbilitySlice | "timed" | "retention";

export interface EvidenceEvent {
  correct: boolean;
  assisted: boolean;
  hintCount: number;
  confidence: number;
  slice: AbilitySlice;
  occurredAt: string;
  source: EvidenceSource;
  excludeFromAssessment?: boolean;
  errorCause?: ErrorCause | null;
}

export type AssessmentOptions = {
  assessmentMode?: AssessmentMode;
  disabledSlices?: AssessmentSlice[];
};

export interface StatusCorrection {
  syllabusPointId: string;
  note: string;
  overrideStatus?: StatusWord | null;
  createdAt: string;
}

const REVIEW_GRADE_EVIDENCE: Record<ReviewGrade, { correct: boolean; confidence: number }> = {
  again: { correct: false, confidence: 1 },
  hard: { correct: true, confidence: 2 },
  good: { correct: true, confidence: 3 },
  easy: { correct: true, confidence: 5 },
};

export function reviewGradeToEvidence(grade: ReviewGrade, occurredAt: string): EvidenceEvent {
  const mapping = REVIEW_GRADE_EVIDENCE[grade];
  return {
    correct: mapping.correct,
    assisted: false,
    hintCount: 0,
    confidence: mapping.confidence,
    slice: "recall",
    occurredAt,
    source: "review",
  };
}

function snapshotId(
  pointId: string,
  effective: EvidenceEvent[],
  totalEvents: number,
  correction: StatusCorrection | undefined,
  options: AssessmentOptions,
  now: Date,
): string {
  const eventsPart = effective
    .map((event) =>
      [
        event.occurredAt,
        event.correct ? "1" : "0",
        event.slice,
        event.confidence,
        event.hintCount,
        event.errorCause ?? "",
        event.source,
      ].join(":"),
    )
    .join(";");
  const correctionPart = correction ? `|${correction.createdAt}|${correction.overrideStatus ?? "disputed"}` : "";
  const disabled = [...(options.disabledSlices ?? [])].sort().join(",");
  const input = `${pointId}|${eventsPart}|${totalEvents}${correctionPart}|${options.assessmentMode ?? "basic"}|${disabled}|${now.toISOString()}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `snap-${(h >>> 0).toString(16).padStart(8, "0")}`;
}

function clipNote(note: string): string {
  return note.length > 40 ? `${note.slice(0, 39)}…` : note;
}

export function deriveStatus(
  syllabusPointId: string,
  events: EvidenceEvent[],
  now: Date,
  corrections: StatusCorrection[] = [],
  options: AssessmentOptions = {},
): StatusResult {
  const disabledSlices = new Set(options.disabledSlices ?? []);
  const effective = events
    .filter((event) => !event.assisted && !event.excludeFromAssessment && !disabledSlices.has(event.slice))
    .slice()
    .sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0));
  const judged =
    options.assessmentMode === "disabled"
      ? {
          status: "untested" as const,
          reasonCodes: ["assessment-disabled"],
          actions: [{ code: "assessment-off", label: "评估已关闭，可继续练习但不更新能力状态", estimatedMinutes: 5 }],
        }
      : applyContextualRules(judge(effective), effective, now, options);
  const latestCorrection = corrections
    .filter((item) => item.syllabusPointId === syllabusPointId)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
    .at(-1);

  let status = judged.status;
  let reasonCodes = [...judged.reasonCodes];
  if (latestCorrection?.overrideStatus) {
    status = latestCorrection.overrideStatus;
    reasonCodes = ["user-correction", ...reasonCodes].slice(0, 3);
  } else if (latestCorrection) {
    reasonCodes = ["user-disputed", ...reasonCodes].slice(0, 3);
  }

  const coverage: SummaryMetric = {
    key: "coverage",
    label: "证据覆盖",
    value: `有效证据 ${Math.min(effective.length, 6)}/6`,
  };
  const last5 = effective.slice(-5);
  const accuracy: SummaryMetric =
    judged.status === "untested"
      ? { key: "recentAccuracy", label: "近期正确率", value: "—" }
      : {
          key: "recentAccuracy",
          label: "近期正确率",
          value: `${Math.round((last5.filter((event) => event.correct).length / last5.length) * 100)}%`,
        };
  const summaryMetrics: SummaryMetric[] = [coverage, accuracy];
  if (latestCorrection) {
    summaryMetrics.push({ key: "correction", label: "纠正说明", value: clipNote(latestCorrection.note) });
  }
  return {
    syllabusPointId,
    status,
    summaryMetrics: summaryMetrics.slice(0, 3),
    reasonCodes,
    recommendedActions: judged.actions,
    evidenceSnapshotId: snapshotId(syllabusPointId, effective, events.length, latestCorrection, options, now),
    strategyVersion: ASSESSMENT_VERSION,
    modelVersion: ASSESSMENT_MODEL_VERSION,
    computedAt: now.toISOString(),
  };
}
