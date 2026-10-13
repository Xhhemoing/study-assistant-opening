import { z } from "zod";
import { defineCapability } from "../capability";

export const COMPARISON_BARS_ID = "comparison-bars@1";

export const comparisonBarsParamsSchema = z
  .object({
    /** What is being compared (column header); shown above the bars. */
    measure: z.string().trim().min(1).max(40),
    unit: z.string().trim().min(1).max(12).optional(),
    bars: z
      .array(z.object({ label: z.string().trim().min(1).max(40), value: z.number().finite().min(0).max(1e12) }).strict())
      .min(2)
      .max(12),
  })
  .strict()
  .superRefine(({ bars }, ctx) => {
    const seen = new Set<string>();
    bars.forEach((bar, index) => {
      if (seen.has(bar.label)) ctx.addIssue({ code: "custom", message: `duplicate label ${bar.label}`, path: ["bars", index, "label"] });
      seen.add(bar.label);
    });
  });

export type ComparisonBarsParams = z.infer<typeof comparisonBarsParamsSchema>;

export function formatBarValue(value: number, unit?: string): string {
  const shown = Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
  return unit ? `${shown} ${unit}` : shown;
}

export function comparisonBarsToText({ measure, unit, bars }: ComparisonBarsParams): string {
  return `${measure}：${bars.map((bar) => `${bar.label} ${formatBarValue(bar.value, unit)}`).join("；")}`;
}

export const comparisonBarsCapability = defineCapability<ComparisonBarsParams>({
  id: COMPARISON_BARS_ID,
  title: "同量纲数值比较",
  tasks: ["compare"],
  modes: ["text", "static", "interactive"],
  params: comparisonBarsParamsSchema,
  limits: ["只比较给出的非负数值，共同零基线；不补造数据、不推断因果"],
  toText: comparisonBarsToText,
});
