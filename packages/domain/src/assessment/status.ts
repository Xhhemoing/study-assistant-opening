import type {
  AbilitySlice,
  RecommendedAction,
  ReviewGrade,
  StatusResult,
  StatusWord,
  SummaryMetric,
} from "@aistudy/contracts";

export const ASSESSMENT_VERSION = "assess-1";
const MODEL_VERSION = "rules-1";

export type EvidenceSource = "attempt" | "review";

export interface EvidenceEvent {
  correct: boolean;
  assisted: boolean;
  hintCount: number;
  confidence: number;
  slice: AbilitySlice;
  occurredAt: string;
  source: EvidenceSource;
}

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

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function snapshotId(
  pointId: string,
  effective: EvidenceEvent[],
  totalEvents: number,
  correction?: StatusCorrection,
): string {
  const lastEvent = effective.at(-1);
  const last = lastEvent ? lastEvent.occurredAt : "none";
  const correctionPart = correction ? `|${correction.createdAt}|${correction.overrideStatus ?? "disputed"}` : "";
  const input = `${pointId}|${last}|${totalEvents}${correctionPart}`;
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

interface Verdict {
  status: StatusWord;
  reasonCodes: string[];
  actions: RecommendedAction[];
}

function judge(effective: EvidenceEvent[]): Verdict {
  const n = effective.length;
  if (n < 2) {
    return {
      status: "untested",
      reasonCodes: ["insufficient-evidence"],
      actions: [{ code: "baseline", label: "做2道基础识别题", estimatedMinutes: 10 }],
    };
  }
  const last3 = effective.slice(-3);
  const latest = effective.at(-1);
  if (!latest) {
    return {
      status: "untested",
      reasonCodes: ["insufficient-evidence"],
      actions: [{ code: "baseline", label: "做2道基础识别题", estimatedMinutes: 10 }],
    };
  }
  if (!latest.correct) {
    const reasonCodes = ["recent-failure"];
    if (mean(last3.map((e) => e.confidence)) <= 2) reasonCodes.push("low-confidence");
    if (mean(last3.map((e) => e.hintCount)) >= 1.5) reasonCodes.push("hint-dependent");
    return {
      status: "weak",
      reasonCodes: reasonCodes.slice(0, 3),
      actions: [
        { code: "hint-steps", label: "步骤提示题", estimatedMinutes: 8 },
        { code: "no-hint-variant", label: "无提示变式", estimatedMinutes: 12 },
      ],
    };
  }
  const streakConfident = last3.every((e) => e.correct) && mean(last3.map((e) => e.confidence)) >= 3;
  const hasTransfer = effective.some((e) => e.slice === "transfer" && e.correct);
  if (n >= 4 && streakConfident && hasTransfer) {
    return {
      status: "stable",
      reasonCodes: ["consistent-success"],
      actions: [{ code: "maintain-transfer", label: "保持节奏：1道迁移题", estimatedMinutes: 12 }],
    };
  }
  return {
    status: "usable",
    reasonCodes: ["partial-mastery"],
    actions: [{ code: "variant", label: "1道变式题巩固", estimatedMinutes: 10 }],
  };
}

export function deriveStatus(
  syllabusPointId: string,
  events: EvidenceEvent[],
  now: Date,
  corrections: StatusCorrection[] = [],
): StatusResult {
  const effective = events
    .filter((e) => !e.assisted)
    .slice()
    .sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0));
  const verdict = judge(effective);
  const latestCorrection = corrections
    .filter((c) => c.syllabusPointId === syllabusPointId)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
    .at(-1);

  let status = verdict.status;
  let reasonCodes = [...verdict.reasonCodes];
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
    verdict.status === "untested"
      ? { key: "recentAccuracy", label: "近期正确率", value: "—" }
      : {
          key: "recentAccuracy",
          label: "近期正确率",
          value: `${Math.round((last5.filter((e) => e.correct).length / last5.length) * 100)}%`,
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
    recommendedActions: verdict.actions,
    evidenceSnapshotId: snapshotId(syllabusPointId, effective, events.length, latestCorrection),
    strategyVersion: ASSESSMENT_VERSION,
    modelVersion: MODEL_VERSION,
    computedAt: now.toISOString(),
  };
}
