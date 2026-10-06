import { z } from "zod";

const STRATEGY_SUFFIX = {
  "default-strict-citation": "所有结论必须锚定所选材料的具体物理页；无法锚定页码时明确拒答，不得编造页码。",
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
