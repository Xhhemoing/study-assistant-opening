import type { RecommendedAction, StatusWord } from "@aistudy/contracts";
import type { AssessmentOptions, EvidenceEvent } from "./status";

export const RETENTION_GAP_MS = 14 * 24 * 60 * 60 * 1000;

export interface Verdict {
  status: StatusWord;
  reasonCodes: string[];
  actions: RecommendedAction[];
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function judge(effective: EvidenceEvent[]): Verdict {
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
    if (mean(last3.map((event) => event.confidence)) <= 2) reasonCodes.push("low-confidence");
    if (mean(last3.map((event) => event.hintCount)) >= 1.5) reasonCodes.push("hint-dependent");
    return {
      status: "weak",
      reasonCodes: reasonCodes.slice(0, 3),
      actions: [
        { code: "hint-steps", label: "步骤提示题", estimatedMinutes: 8 },
        { code: "no-hint-variant", label: "无提示变式", estimatedMinutes: 12 },
      ],
    };
  }
  const streakConfident = last3.every((event) => event.correct) && mean(last3.map((event) => event.confidence)) >= 3;
  const hasTransfer = effective.some((event) => event.slice === "transfer" && event.correct);
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

export function applyContextualRules(
  verdict: Verdict,
  effective: EvidenceEvent[],
  now: Date,
  options: AssessmentOptions,
): Verdict {
  if (options.assessmentMode === "disabled") return verdict;
  const disabled = new Set(options.disabledSlices ?? []);
  const extra: string[] = [];
  let status = verdict.status;

  const window = effective.slice(-6);
  if (!disabled.has("timed") && window.some((event) => event.errorCause === "time")) {
    extra.push("timed-unstable");
    if (status === "stable") status = "usable";
  }

  const last3 = effective.slice(-3);
  const repeatedCause = last3[0]?.errorCause;
  if (repeatedCause && last3.length === 3 && last3.every((event) => event.errorCause === repeatedCause)) {
    extra.push("repeated-error-cause");
  }

  const latest = effective.at(-1);
  const ageMs = latest ? now.getTime() - Date.parse(latest.occurredAt) : Number.NaN;
  if (!disabled.has("retention") && Number.isFinite(ageMs) && ageMs > RETENTION_GAP_MS) {
    extra.push("retention-gap");
    if (status === "stable") status = "usable";
  }

  return {
    status,
    reasonCodes: [...extra, ...verdict.reasonCodes].slice(0, 3),
    actions: verdict.actions,
  };
}
