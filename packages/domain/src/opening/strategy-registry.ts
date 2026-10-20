import { z } from "zod";

const STRATEGY_SUFFIX = {
  "default-strict-citation": "材料内容论断必须锚定所选材料的具体物理页；无法锚定时明确说明材料证据不足，不得编造页码。系统状态事实只依据本轮服务端结构化查询回执及记录链接，不要求 PDF 页码；历史聊天不能证明当前状态。一般数学知识可直接解释，并明确不冒充所选材料原文或个人学习记录。",
} as const;

export const strategyTemplateSchema = z
  .object({
    id: z.literal("default-strict-citation"),
    version: z.string().min(1).max(20),
    displayName: z.string().min(1).max(120),
    citationPolicy: z.literal("require_page"),
    instructionSuffix: z.string().min(1).max(1200),
  })
  .strict();

export type StrategyTemplate = z.infer<typeof strategyTemplateSchema>;

const DEFAULT_TEMPLATE: StrategyTemplate = strategyTemplateSchema.parse({
  id: "default-strict-citation",
  version: "1",
  displayName: "严格页码引用",
  citationPolicy: "require_page",
  instructionSuffix: STRATEGY_SUFFIX["default-strict-citation"],
});

const TEMPLATES: Record<string, StrategyTemplate> = {
  [DEFAULT_TEMPLATE.id]: DEFAULT_TEMPLATE,
};

export const DEFAULT_STRATEGY_TEMPLATE_ID = DEFAULT_TEMPLATE.id;

export function resolveStrategyTemplate(
  id: string | null | undefined,
): StrategyTemplate {
  return (id && TEMPLATES[id]) || DEFAULT_TEMPLATE;
}

export function getStrategyTemplate(id: string): StrategyTemplate {
  const template = TEMPLATES[id];
  if (!template) {
    throw new Error(`unknown strategy template: ${id}`);
  }
  return template;
}

export function listStrategyTemplates(): StrategyTemplate[] {
  return Object.values(TEMPLATES);
}
