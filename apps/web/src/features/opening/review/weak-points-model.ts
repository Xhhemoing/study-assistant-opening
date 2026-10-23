import type { LearningObservation } from "@aistudy/contracts";

/** 学生自选错因（决定：由学生选择，不做 AI 判定）。 */
export const errorCauses = [
  { id: "concept", label: "概念不清" },
  { id: "step", label: "步骤遗漏" },
  { id: "calc", label: "计算失误" },
  { id: "reading", label: "审题偏差" },
  { id: "memory", label: "记不起来" },
] as const;
export type ErrorCause = typeof errorCauses[number]["id"];

export type WeakPoint = {
  key: string;
  courseId: string;
  courseTitle: string;
  skillLabel: string;
  /** 答错次数（原始作答，不含撤回）。 */
  incorrect: number;
  /** 看了提示或示范才完成的次数。 */
  assisted: number;
  /** 独立且正确的次数。 */
  independentCorrect: number;
  total: number;
  lastStruggleAt: string;
};

type Obs = Pick<LearningObservation, "id" | "courseId" | "skillLabel" | "outcome" | "assistance" | "occurredAt"> & {
  revisionKind?: LearningObservation["revisionKind"];
  revisesObservationId?: string | null;
};

/** 只看每条作答的最新有效版本：撤回的去掉，被修订的用修订版。 */
export function effectiveObservations<T extends Obs>(observations: readonly T[]): T[] {
  const superseded = new Set(observations.map(item => item.revisesObservationId).filter((id): id is string => Boolean(id)));
  return observations.filter(item => !superseded.has(item.id) && item.revisionKind !== "retract");
}

/**
 * 易错点 = 同一技能上出现过答错或靠帮助完成的作答。
 * 排序：困难次数多的在前，同等时最近的在前。独立正确不抵消历史，只作为参照显示。
 */
export function buildWeakPoints(observations: readonly Obs[], courseTitles: ReadonlyMap<string, string>): WeakPoint[] {
  const groups = new Map<string, WeakPoint>();
  for (const item of effectiveObservations(observations)) {
    const key = `${item.courseId}\u0000${item.skillLabel}`;
    const current = groups.get(key) ?? { key, courseId: item.courseId, courseTitle: courseTitles.get(item.courseId) ?? "课程", skillLabel: item.skillLabel, incorrect: 0, assisted: 0, independentCorrect: 0, total: 0, lastStruggleAt: "" };
    current.total += 1;
    const struggled = item.outcome === "incorrect" || item.assistance === "hinted" || item.assistance === "revealed";
    if (item.outcome === "incorrect") current.incorrect += 1;
    else if (item.assistance === "hinted" || item.assistance === "revealed") current.assisted += 1;
    if (item.outcome === "correct" && item.assistance === "independent") current.independentCorrect += 1;
    if (struggled && item.occurredAt > current.lastStruggleAt) current.lastStruggleAt = item.occurredAt;
    groups.set(key, current);
  }
  return [...groups.values()]
    .filter(point => point.incorrect + point.assisted > 0)
    .sort((a, b) => (b.incorrect + b.assisted) - (a.incorrect + a.assisted) || b.lastStruggleAt.localeCompare(a.lastStruggleAt));
}

export function practiceHref(point: Pick<WeakPoint, "courseId" | "skillLabel">): string {
  return `/opening/courses/${encodeURIComponent(point.courseId)}/study?mode=practice&skillLabel=${encodeURIComponent(point.skillLabel)}`;
}

const CAUSE_KEY = "aistudy:weak-point-causes";
/** 错因只保存在本机（不进入学习证据），学生随时可改。 */
export function readCauses(storage: Pick<Storage, "getItem"> | null): Record<string, ErrorCause> {
  try {
    const raw = storage?.getItem(CAUSE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object") return {};
    const valid = new Set<string>(errorCauses.map(cause => cause.id));
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, ErrorCause] => typeof entry[1] === "string" && valid.has(entry[1])));
  } catch {
    return {};
  }
}
export function writeCauses(storage: Pick<Storage, "setItem"> | null, causes: Record<string, ErrorCause>): void {
  try { storage?.setItem(CAUSE_KEY, JSON.stringify(causes)); } catch { /* 存储不可用时只影响本次 */ }
}
