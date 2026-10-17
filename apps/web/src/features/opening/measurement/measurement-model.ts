import type { MeasurementAttempt, MeasurementOverview, MeasurementPhase } from "@aistudy/contracts";

export const measurementPhaseLabels: Record<MeasurementPhase, string> = {
  practice: "初次练习", delay_48h: "48 小时复测", delay_7d: "7 天复测",
};

/** Do not issue a replacement for an unanswered item after a refresh or failed response. */
export function activeMeasurementAttempt(overview: MeasurementOverview): MeasurementAttempt | null {
  return overview.attempts.find(attempt => attempt.answeredAt === null && attempt.retractedAt === null) ?? null;
}

export function measurementCanContinue(overview: MeasurementOverview, now: number): boolean {
  return overview.trial?.status === "active" && activeMeasurementAttempt(overview) === null
    && (overview.nextDueAt === null || Date.parse(overview.nextDueAt) <= now);
}

export function measurementDate(value: string): string {
  return new Date(value).toLocaleString("zh-CN", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function actualDelay(attempt: MeasurementAttempt, overview: MeasurementOverview): string | null {
  const origin = overview.trial?.practiceCompletedAt;
  if (attempt.item.phase === "practice" || !origin) return null;
  const end = attempt.answeredAt ?? attempt.presentedAt;
  const hours = (Date.parse(end) - Date.parse(origin)) / 3_600_000;
  return Number.isFinite(hours) ? `${Math.max(0, hours).toFixed(1)} 小时` : null;
}
