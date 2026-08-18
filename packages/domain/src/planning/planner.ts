import type { PlannedTask, PlanOption, TodayPlan } from "@aistudy/contracts";
import type { AssessmentMode, ScenarioPreset, StatusWord } from "@aistudy/contracts";
import type { GoalKind } from "../goals/effective-requirements";
import { getScenarioPresetDefinition } from "./scenario-presets";
import { optionCopyForKind, scenarioToGoalKind, tierOrderForKind } from "./kinds";

export const PLANNER_VERSION = "plan-1";
const TITLE_MAX = 24;

export interface PlannerPointInput {
  pointId: string;
  title: string;
  status: StatusWord;
  estimatedMinutes: number;
  practiceItemId: string;
}

export interface PlannerGoalInput {
  id: string;
  kind: GoalKind;
}

export interface PlannerInput {
  ownerUserId: string;
  date: string;
  budgetMinutes: number;
  scenario: ScenarioPreset;
  points: PlannerPointInput[];
  dueReviews: Array<{ cardId: string; front: string; estimatedMinutes: number }>;
  lockedTasks: PlannedTask[];
  assessmentMode?: AssessmentMode;
  goalKind?: GoalKind;
  goals?: PlannerGoalInput[];
  protectedExplorationMinutes?: number;
  planningEnabled?: boolean;
  evidenceSnapshotId?: string;
}

function clipTitle(title: string): string {
  return Array.from(title).slice(0, TITLE_MAX).join("");
}

function byTitle(a: PlannerPointInput, b: PlannerPointInput): number {
  const cmp = a.title.localeCompare(b.title, "zh-Hans-CN");
  return cmp !== 0 ? cmp : a.pointId < b.pointId ? -1 : a.pointId > b.pointId ? 1 : 0;
}

function fingerprint(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `snap-${(h >>> 0).toString(16).padStart(8, "0")}`;
}

function pack(budgetMinutes: number, reserved: PlannedTask[], queue: PlannedTask[]): PlannedTask[] {
  const tasks = [...reserved];
  let total = tasks.reduce((sum, task) => sum + task.estimatedMinutes, 0);
  for (const candidate of queue) {
    if (total + candidate.estimatedMinutes <= budgetMinutes) {
      tasks.push(candidate);
      total += candidate.estimatedMinutes;
    }
  }
  return tasks;
}

function reviewTasks(input: PlannerInput): PlannedTask[] {
  return input.dueReviews
    .slice()
    .sort((a, b) => (a.cardId < b.cardId ? -1 : a.cardId > b.cardId ? 1 : 0))
    .map((review) => ({
      id: `plan-${input.date}-review-${review.cardId}`,
      kind: "review" as const,
      refId: review.cardId,
      title: clipTitle(review.front),
      estimatedMinutes: review.estimatedMinutes,
      reason: "今日到期的复习卡",
      locked: false,
      status: "pending" as const,
    }));
}

function practiceTasks(input: PlannerInput, kind: GoalKind): PlannedTask[] {
  if ((input.assessmentMode ?? "basic") === "disabled") return [];
  const pointsByStatus = new Map<StatusWord, PlannerPointInput[]>();
  for (const point of input.points) {
    if (point.status === "stable") continue;
    const list = pointsByStatus.get(point.status) ?? [];
    list.push(point);
    pointsByStatus.set(point.status, list);
  }
  const fallback = getScenarioPresetDefinition(input.scenario);
  const tasks: PlannedTask[] = [];
  for (const status of tierOrderForKind(kind)) {
    const tier = (pointsByStatus.get(status) ?? []).slice().sort(byTitle);
    for (const point of tier) {
      tasks.push({
        id: `plan-${input.date}-practice-${point.practiceItemId}`,
        kind: "practice",
        refId: point.practiceItemId,
        title: clipTitle(point.title),
        estimatedMinutes: point.estimatedMinutes,
        reason: fallback.reasonByStatus[status],
        locked: false,
        status: "pending",
      });
    }
  }
  return tasks;
}

function reservedTasks(input: PlannerInput): PlannedTask[] {
  const locked = input.lockedTasks.map((task) => ({ ...task, locked: true as const }));
  const minutes = Math.min(Math.max(0, input.protectedExplorationMinutes ?? 0), input.budgetMinutes);
  if (minutes <= 0) return locked;
  return [
    ...locked,
    {
      id: `plan-${input.date}-explore-protected`,
      kind: "explore",
      refId: "protected-exploration",
      title: "自由探索",
      estimatedMinutes: minutes,
      reason: "预留的探索时间，不被计划挤占",
      locked: true,
      status: "pending",
    },
  ];
}

function optionsForKinds(input: PlannerInput, kinds: GoalKind[], reserved: PlannedTask[]): PlanOption[] {
  const seen = new Set<string>();
  const options: PlanOption[] = [];
  for (const kind of kinds) {
    const tasks = pack(input.budgetMinutes, reserved, [...reviewTasks(input), ...practiceTasks(input, kind)]).filter(
      (task) => !reserved.some((item) => item.id === task.id),
    );
    const signature = tasks.map((task) => task.id).join("|");
    if (seen.has(signature)) continue;
    seen.add(signature);
    const copy = optionCopyForKind(kind);
    options.push({ ...copy, tasks });
  }
  return options;
}

export function buildTodayPlan(input: PlannerInput): TodayPlan {
  const snapshot =
    input.evidenceSnapshotId ??
    fingerprint(
      `${input.date}|${input.points.map((point) => `${point.pointId}:${point.status}`).join(",")}|${input.dueReviews.map((review) => review.cardId).join(",")}`,
    );
  const empty = {
    id: `plan-${input.ownerUserId}-${input.date}`,
    ownerUserId: input.ownerUserId,
    date: input.date,
    budgetMinutes: input.budgetMinutes,
    totalMinutes: 0,
    tasks: [] as PlannedTask[],
    options: [] as PlanOption[],
    strategyVersion: PLANNER_VERSION,
    generatedAt: `${input.date}T00:00:00.000Z`,
    evidenceSnapshotId: snapshot,
  };
  if (input.planningEnabled === false) return empty;

  const reserved = reservedTasks(input);
  const declared = input.goals?.map((goal) => goal.kind) ?? [];
  const uniqueKinds = [...new Set(declared)];
  const primaryKind = input.goalKind ?? uniqueKinds[0] ?? scenarioToGoalKind(input.scenario);
  const options = uniqueKinds.length >= 2 ? optionsForKinds(input, uniqueKinds, reserved).slice(0, 3) : [];
  const tasks =
    options.length >= 2
      ? reserved
      : pack(input.budgetMinutes, reserved, [...reviewTasks(input), ...practiceTasks(input, primaryKind)]);
  return {
    ...empty,
    totalMinutes: tasks.reduce((sum, task) => sum + task.estimatedMinutes, 0),
    tasks,
    options,
  };
}
