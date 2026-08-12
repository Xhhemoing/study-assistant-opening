import type {
  AbilityDimension,
  AbilityWeights,
  AssessmentMode,
  CourseRequirementInput,
  CourseRequirementProfile,
  RequirementProfileKind,
} from "@aistudy/contracts";

export const REQUIREMENT_PROFILE_VERSION = "req-profile-1";

const DIMENSIONS: readonly AbilityDimension[] = [
  "recognition",
  "recall",
  "procedural",
  "transfer",
  "expression",
  "timed",
];

export interface RequirementPreset {
  kind: RequirementProfileKind;
  label: string;
  description: string;
  abilities: AbilityWeights;
}

function weights(
  recognition: number,
  recall: number,
  procedural: number,
  transfer: number,
  expression: number,
  timed: number,
): AbilityWeights {
  return { recognition, recall, procedural, transfer, expression, timed };
}

/** 六类课程需求画像预设；完整权重总和为 100。 */
export const REQUIREMENT_PROFILES: RequirementPreset[] = [
  {
    kind: "memory",
    label: "记忆型",
    description: "历史年份、外语词汇、医学名词等需要大量无提示回忆的内容。",
    abilities: weights(25, 40, 5, 15, 5, 10),
  },
  {
    kind: "mathematical-procedural",
    label: "数理与程序",
    description: "数学、物理、算法等需要逐步求解和程序执行的内容。",
    abilities: weights(10, 15, 35, 25, 5, 10),
  },
  {
    kind: "language",
    label: "语言学习",
    description: "外语听说读写，强调表达输出与限时稳定。",
    abilities: weights(15, 25, 5, 15, 25, 15),
  },
  {
    kind: "research-writing",
    label: "研究写作",
    description: "论文、论述、报告等需要结构化表达与迁移的内容。",
    abilities: weights(10, 15, 5, 20, 40, 10),
  },
  {
    kind: "programming-project",
    label: "编程项目",
    description: "代码、作品和项目，强调动手实践与迁移应用。",
    abilities: weights(5, 5, 30, 25, 20, 15),
  },
  {
    kind: "free-exploration",
    label: "自由探索",
    description: "兴趣驱动的开放式学习，不预设考试目标。",
    abilities: weights(20, 15, 15, 20, 20, 10),
  },
];

export const REQUIREMENT_PROFILES_BY_KIND: Record<RequirementProfileKind, RequirementPreset> =
  Object.fromEntries(REQUIREMENT_PROFILES.map((preset) => [preset.kind, preset])) as Record<
    RequirementProfileKind,
    RequirementPreset
  >;

export function listRequirementProfileKinds(): RequirementProfileKind[] {
  return REQUIREMENT_PROFILES.map((preset) => preset.kind);
}

export function getRequirementProfile(
  kind: RequirementProfileKind,
  assessmentMode: AssessmentMode,
): CourseRequirementProfile {
  const preset = REQUIREMENT_PROFILES_BY_KIND[kind];
  return {
    kind,
    assessmentMode,
    abilities: preset.abilities,
    strategyVersion: REQUIREMENT_PROFILE_VERSION,
  };
}

export function resolveRequirementProfile(
  input: CourseRequirementInput,
): CourseRequirementProfile {
  const kind = input.kind ?? "free-exploration";
  const assessmentMode = input.assessmentMode ?? "basic";
  return getRequirementProfile(kind, assessmentMode);
}

export function isAssessmentEnabled(profile: CourseRequirementProfile): boolean {
  return profile.assessmentMode !== "disabled";
}

export function validateAbilityWeights(weights: AbilityWeights): boolean {
  const sum = DIMENSIONS.reduce((total, key) => total + weights[key], 0);
  return (
    DIMENSIONS.every(
      (key) =>
        Number.isInteger(weights[key]) && weights[key] >= 0 && weights[key] <= 100,
    ) && sum === 100
  );
}

/**
 * 将任意非负权重归一化到总和 100（开发者设置调整权重后调用）。
 * 非有限值视为 0；全 0 时回退到自由探索预设。
 */
export function normalizeAbilityWeights(input: Partial<AbilityWeights>): AbilityWeights {
  const raw = DIMENSIONS.map((key) => {
    const value = input[key];
    return Number.isFinite(value) ? Math.max(0, Math.min(100, Number(value))) : 0;
  });
  const sum = raw.reduce((total, value) => total + value, 0);
  if (sum <= 0) {
    return REQUIREMENT_PROFILES_BY_KIND["free-exploration"].abilities;
  }
  const scaled = raw.map((value) => Math.round((value * 100) / sum));
  const head = scaled.slice(0, -1).reduce((total, value) => total + value, 0);
  scaled[scaled.length - 1] = Math.max(0, 100 - head);
  return weights(
    scaled[0]!,
    scaled[1]!,
    scaled[2]!,
    scaled[3]!,
    scaled[4]!,
    scaled[5]!,
  );
}
