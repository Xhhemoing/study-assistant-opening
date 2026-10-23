import { z } from "zod";
import type { LearnerStateFeature } from "@aistudy/domain";

/** Student-selected explanations remain local preferences, never grading evidence. */
export const errorCauses = [
  { id: "concept", label: "概念不清" }, { id: "step", label: "步骤遗漏" },
  { id: "calc", label: "计算失误" }, { id: "reading", label: "审题偏差" },
  { id: "memory", label: "记不起来" },
] as const;
export type ErrorCause = typeof errorCauses[number]["id"];

export const weakPointStates = ["due_retest", "needs_practice", "needs_check", "recent_independent", "delayed_checked"] as const;
export const weakPointStateLabels: Record<typeof weakPointStates[number], string> = {
  due_retest: "到期复测", needs_practice: "继续练习", needs_check: "待核对",
  recent_independent: "最近独立完成", delayed_checked: "延迟检查通过",
};
const count = z.number().int().nonnegative();
const weakPointSchema = z.object({
  key: z.string(), courseId: z.string().uuid(), courseTitle: z.string(),
  requirementKey: z.string().nullable(), skillLabel: z.string(),
  state: z.enum(weakPointStates), identityKnown: z.boolean(),
  incorrect: count, assisted: count, independentCorrect: count, total: count,
  lastAttemptAt: z.string().datetime(), lastStruggleAt: z.string().datetime().nullable(),
}).strict();
export const weakPointsSummarySchema = z.object({
  points: z.array(weakPointSchema), evaluatedAt: z.string().datetime(), incomplete: z.boolean(),
}).strict();
export type WeakPoint = z.infer<typeof weakPointSchema>;
export type WeakPointsSummary = z.infer<typeof weakPointsSummarySchema>;
type Feature = Pick<LearnerStateFeature, "observationId" | "courseId" | "requirementKey" | "skillLabel" | "attemptedAt" | "eligibility" | "views" | "retention">;
export type WeakPointsRead = {
  dataAsOf: string; features: readonly Feature[];
  display: { requirements: readonly { courseId: string; requirementKey: string; dueRetest: boolean }[] };
  completeness: { total: number; status: "complete" | "truncated" | "unavailable" };
};

const knownRequirement = (key: string | null) => key !== null && key !== "";
const identity = (courseId: string, requirementKey: string) => JSON.stringify([courseId, requirementKey]);
function latestState(rows: readonly Feature[], identityKnown: boolean): WeakPoint["state"] {
  if (!identityKnown || rows.some(row => row.eligibility.usableForCurrentVersion !== "yes")) return "needs_check";
  const independent = (row: Feature) => row.eligibility.verifiedCorrect === "yes" && row.eligibility.independentAttempt === "yes";
  if (rows.every(independent)) {
    return rows.every(row => row.eligibility.usableForDelayedCheck === "yes" && row.views.includes("retention") && row.retention.protocolId !== null)
      ? "delayed_checked" : "recent_independent";
  }
  // Equal original-attempt timestamps establish no order between conflicting answers.
  if (rows.some(independent)) return "needs_check";
  if (rows.every(row => row.eligibility.verifiedCorrect === "no"
    || (row.eligibility.verifiedCorrect === "yes" && row.eligibility.independentAttempt === "no"))) return "needs_practice";
  return "needs_check";
}

/** Uses the complete, owner-qualified effective-head sequence, never UI representatives. */
export function buildWeakPoints(read: WeakPointsRead, courseTitles: ReadonlyMap<string, string>): WeakPointsSummary {
  const groups = new Map<string, Feature[]>();
  for (const row of read.features) {
    // Unassigned records remain separate: a shared display label is not a learning identity.
    const key = knownRequirement(row.requirementKey) ? identity(row.courseId, row.requirementKey!)
      : JSON.stringify([row.courseId, row.requirementKey, row.observationId]);
    const group = groups.get(key);
    if (group) group.push(row); else groups.set(key, [row]);
  }
  const due = new Set(read.display.requirements.filter(row => row.dueRetest).map(row => identity(row.courseId, row.requirementKey)));
  const points: WeakPoint[] = [];
  for (const [key, rows] of groups) {
    const latestTime = rows.reduce((value, row) => Math.max(value, Date.parse(row.attemptedAt)), -Infinity);
    const latest = rows.filter(row => Date.parse(row.attemptedAt) === latestTime);
    const head = latest.at(-1)!;
    const identityKnown = knownRequirement(head.requirementKey);
    const state = identityKnown && due.has(key) ? "due_retest" : latestState(latest, identityKnown);
    const incorrect = rows.filter(row => row.eligibility.verifiedCorrect === "no").length;
    const assisted = rows.filter(row => row.eligibility.verifiedCorrect === "yes" && row.eligibility.independentAttempt === "no").length;
    const struggles = rows.filter(row => row.eligibility.verifiedCorrect === "no"
      || (row.eligibility.verifiedCorrect === "yes" && row.eligibility.independentAttempt === "no"));
    if (!incorrect && !assisted && (state === "recent_independent" || state === "delayed_checked")) continue;
    points.push({ key, courseId: head.courseId, courseTitle: courseTitles.get(head.courseId) ?? "课程",
      requirementKey: head.requirementKey, skillLabel: head.skillLabel, state, identityKnown,
      incorrect, assisted, total: rows.length,
      independentCorrect: rows.filter(row => row.eligibility.verifiedCorrect === "yes" && row.eligibility.independentAttempt === "yes"
        && row.eligibility.usableForCurrentVersion === "yes").length,
      lastAttemptAt: head.attemptedAt,
      lastStruggleAt: struggles.length ? new Date(struggles.reduce((value, row) => Math.max(value, Date.parse(row.attemptedAt)), -Infinity)).toISOString() : null });
  }
  points.sort((a, b) => weakPointStates.indexOf(a.state) - weakPointStates.indexOf(b.state)
    || Date.parse(b.lastAttemptAt) - Date.parse(a.lastAttemptAt) || a.key.localeCompare(b.key));
  return { points, evaluatedAt: read.dataAsOf,
    incomplete: read.completeness.status === "unavailable" || read.features.length !== read.completeness.total };
}

export function practiceHref(point: Pick<WeakPoint, "courseId" | "skillLabel"> & { requirementKey?: string | null }): string {
  const query = new URLSearchParams({ mode: "practice", skillLabel: point.skillLabel });
  if (point.requirementKey) query.set("requirementKey", point.requirementKey);
  return `/opening/courses/${encodeURIComponent(point.courseId)}/study?${query}`;
}

export function retestQueueHref(point: Pick<WeakPoint, "courseId" | "requirementKey">): string {
  const query = new URLSearchParams({ tab: "retests", courseId: point.courseId });
  if (point.requirementKey) query.set("requirementKey", point.requirementKey);
  return `/opening/review?${query}`;
}

const CAUSE_KEY = "aistudy:weak-point-causes";
/** Local-only student preferences; do not promote them into evidence or mastery. */
export function readCauses(storage: Pick<Storage, "getItem"> | null): Record<string, ErrorCause> {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(CAUSE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object") return {};
    const valid = new Set<string>(errorCauses.map(cause => cause.id));
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, ErrorCause] => typeof entry[1] === "string" && valid.has(entry[1])));
  } catch { return {}; }
}
export function writeCauses(storage: Pick<Storage, "setItem"> | null, causes: Record<string, ErrorCause>): void {
  try { storage?.setItem(CAUSE_KEY, JSON.stringify(causes)); } catch { /* Optional local preference only. */ }
}
