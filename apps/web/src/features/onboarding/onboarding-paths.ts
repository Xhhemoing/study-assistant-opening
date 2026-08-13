import type { WorkspaceEntry } from "@aistudy/ui";

export const ONBOARDING_PATH_IDS = [
  "free-exploration",
  "goal-course",
  "knowledge-course",
  "promote-exploration",
] as const;

export type OnboardingPathId = (typeof ONBOARDING_PATH_IDS)[number];

export interface OnboardingPath {
  id: OnboardingPathId;
  entry: WorkspaceEntry;
  title: string;
  description: string;
  href: string;
  /** 该路径是否建议（不强制）先创建一个学习目标。 */
  suggestsGoal: boolean;
}

/**
 * 可选的 onboarding 起始路径。任何一条都不强制用户在进入探索或知识库之前
 * 先创建课程或目标——「自由探索」始终无前置条件。
 */
export const ONBOARDING_PATHS: readonly OnboardingPath[] = [
  {
    id: "free-exploration",
    entry: "explore",
    title: "自由探索",
    description: "从问题、资料或一个想法直接开始，无需先创建课程或目标。",
    href: "/explore",
    suggestsGoal: false,
  },
  {
    id: "goal-course",
    entry: "learn",
    title: "目标驱动课程",
    description: "创建课程并设置一个明确的考试目标，让计划围绕它展开。",
    href: "/learn/courses/new",
    suggestsGoal: true,
  },
  {
    id: "knowledge-course",
    entry: "learn",
    title: "仅知识课程",
    description: "只创建课程积累知识，暂不设置学习计划。",
    href: "/learn/courses/new",
    suggestsGoal: false,
  },
  {
    id: "promote-exploration",
    entry: "explore",
    title: "从探索沉淀课程",
    description: "把探索中的候选内容提升为一门新课程。",
    href: "/explore",
    suggestsGoal: false,
  },
];

export function onboardingPathById(id: OnboardingPathId): OnboardingPath | undefined {
  return ONBOARDING_PATHS.find((path) => path.id === id);
}

export function hasUnblockedExploration(paths: readonly OnboardingPath[]): boolean {
  return paths.some((path) => path.entry === "explore" && !path.suggestsGoal);
}
