import type {
  PlannedTask,
  ScenarioPreset,
  StatusWord,
  TodayPlan,
} from "@aistudy/contracts";

export const PLANNER_VERSION = "plan-1";

export interface PlannerPointInput {
  pointId: string;
  title: string;
  status: StatusWord;
  estimatedMinutes: number;
  practiceItemId: string;
}

export interface PlannerInput {
  ownerUserId: string;
  date: string;
  budgetMinutes: number;
  scenario: ScenarioPreset;
  points: PlannerPointInput[];
  dueReviews: Array<{ cardId: string; front: string; estimatedMinutes: number }>;
  lockedTasks: PlannedTask[];
}

const TITLE_MAX = 24;

const REASON_BY_STATUS: Record<Exclude<StatusWord, "stable">, string> = {
  weak: "薄弱考点，优先补缺",
  untested: "尚未测评，先建立基线",
  usable: "做一道变式保持手感",
};

function tierOrder(scenario: ScenarioPreset): Array<Exclude<StatusWord, "stable">> {
  return scenario === "gaokao" || scenario === "kaoyan"
    ? ["weak", "usable", "untested"]
    : ["weak", "untested", "usable"];
}

function clipTitle(title: string): string {
  return Array.from(title).slice(0, TITLE_MAX).join("");
}

function byTitle(a: PlannerPointInput, b: PlannerPointInput): number {
  const cmp = a.title.localeCompare(b.title, "zh-Hans-CN");
  return cmp !== 0 ? cmp : a.pointId < b.pointId ? -1 : a.pointId > b.pointId ? 1 : 0;
}

export function buildTodayPlan(input: PlannerInput): TodayPlan {
  const tasks: PlannedTask[] = input.lockedTasks.map((t) => ({ ...t, locked: true }));
  let totalMinutes = tasks.reduce((sum, t) => sum + t.estimatedMinutes, 0);

  const reviews = input.dueReviews
    .slice()
    .sort((a, b) => (a.cardId < b.cardId ? -1 : a.cardId > b.cardId ? 1 : 0));
  const pointsByStatus = new Map<StatusWord, PlannerPointInput[]>();
  for (const p of input.points) {
    if (p.status === "stable") continue;
    const list = pointsByStatus.get(p.status) ?? [];
    list.push(p);
    pointsByStatus.set(p.status, list);
  }

  const queue: PlannedTask[] = [];
  for (const review of reviews) {
    queue.push({
      id: `plan-${input.date}-review-${review.cardId}`,
      kind: "review",
      refId: review.cardId,
      title: clipTitle(review.front),
      estimatedMinutes: review.estimatedMinutes,
      reason: "今日到期的复习卡",
      locked: false,
      status: "pending",
    });
  }
  for (const status of tierOrder(input.scenario)) {
    const tier = (pointsByStatus.get(status) ?? []).slice().sort(byTitle);
    for (const p of tier) {
      queue.push({
        id: `plan-${input.date}-practice-${p.practiceItemId}`,
        kind: "practice",
        refId: p.practiceItemId,
        title: clipTitle(p.title),
        estimatedMinutes: p.estimatedMinutes,
        reason: REASON_BY_STATUS[status],
        locked: false,
        status: "pending",
      });
    }
  }

  for (const candidate of queue) {
    if (totalMinutes + candidate.estimatedMinutes <= input.budgetMinutes) {
      tasks.push(candidate);
      totalMinutes += candidate.estimatedMinutes;
    }
  }

  return {
    id: `plan-${input.ownerUserId}-${input.date}`,
    ownerUserId: input.ownerUserId,
    date: input.date,
    budgetMinutes: input.budgetMinutes,
    totalMinutes,
    tasks,
    options: [],
    strategyVersion: PLANNER_VERSION,
    generatedAt: `${input.date}T00:00:00.000Z`,
  };
}
