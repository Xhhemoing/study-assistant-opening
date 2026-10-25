import { z } from "zod";
import initialGates from "./senseweave-gates.v0.json";

export const senseWeaveComponentSchema = z.enum([
  "prose", "callout", "details", "steps", "diagram", "table", "compare", "checklist", "timeline", "chart", "plot",
]);
const components = z.array(senseWeaveComponentSchema).max(11).refine(values => new Set(values).size === values.length);
export const senseWeaveGatesSchema = z.object({
  version: z.string().regex(/^sw-gates-[a-z0-9-]{1,64}$/),
  presets: z.object({ hint: components, explain: components, review: components, plan: components, data: components }).strict(),
}).strict().superRefine((value, context) => {
  if (value.presets.hint.some(type => !["prose", "callout", "details"].includes(type))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["presets", "hint"], message: "hint cannot enable answer-revealing components" });
  }
});
export type SenseWeaveGates = z.infer<typeof senseWeaveGatesSchema>;
/** Frozen product defaults, NOT evidence that any component is preferred or improves learning. */
export const SENSEWEAVE_INITIAL_GATES: SenseWeaveGates = senseWeaveGatesSchema.parse(initialGates);
