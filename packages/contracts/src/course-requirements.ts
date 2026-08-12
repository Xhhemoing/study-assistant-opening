import { z } from "zod";

/**
 * 课程需求画像类型：决定一门课程默认收集哪些能力证据、
 * 安排哪些活动组合，以及是否需要评估。
 */
export const requirementProfileKindSchema = z.enum([
  "memory",
  "mathematical-procedural",
  "language",
  "research-writing",
  "programming-project",
  "free-exploration",
]);

/** basic = 启用基础评估（简单预设）；disabled = 禁用评估。 */
export const assessmentModeSchema = z.enum(["basic", "disabled"]);

/** 六维能力维度，顺序固定，供 UI 与领域逻辑共用。 */
export const abilityDimensions = [
  "recognition",
  "recall",
  "procedural",
  "transfer",
  "expression",
  "timed",
] as const;

export type AbilityDimension = (typeof abilityDimensions)[number];

export const abilityWeightsSchema = z.object({
  recognition: z.number().int().min(0).max(100),
  recall: z.number().int().min(0).max(100),
  procedural: z.number().int().min(0).max(100),
  transfer: z.number().int().min(0).max(100),
  expression: z.number().int().min(0).max(100),
  timed: z.number().int().min(0).max(100),
});

export const courseRequirementProfileSchema = z.object({
  kind: requirementProfileKindSchema,
  assessmentMode: assessmentModeSchema,
  abilities: abilityWeightsSchema,
  strategyVersion: z.string().min(1),
});

/** 简化设置页面可编辑的字段；完整权重只在开发者设置中调整。 */
export const courseRequirementInputSchema = z.object({
  kind: requirementProfileKindSchema.default("free-exploration"),
  assessmentMode: assessmentModeSchema.default("basic"),
});

export type RequirementProfileKind = z.infer<typeof requirementProfileKindSchema>;
export type AssessmentMode = z.infer<typeof assessmentModeSchema>;
export type AbilityWeights = z.infer<typeof abilityWeightsSchema>;
export type CourseRequirementProfile = z.infer<typeof courseRequirementProfileSchema>;
export type CourseRequirementInput = z.input<typeof courseRequirementInputSchema>;
