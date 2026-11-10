"use client";

import type { spanPrerequisiteRepairContextSchema, SpanRepairContext, SpanTargetedExplanation } from "@aistudy/contracts";
import type { z } from "zod";
import { LearningProse } from "../../assistant/learning-prose";

const boundary = "这里只补本题中最早有证据支持的步骤，不判断你为什么出错；外部先修关系与薄弱证据尚未确认。";
/** Shared content projection: never adds the generic lesson, Explorer or future-stage answers. */
export function spanTargetedExplanationText(context: SpanRepairContext, explanation: SpanTargetedExplanation): string {
  if (context.status !== "ready" || explanation.targetSkill !== context.targetSkill) throw new Error("本题步骤内容与当前计划不一致；未回退通用讲解。");
  return [context.focusSummary, boundary, explanation.brief,
    ...explanation.workedSteps.map(step => `### ${step.label}\n\n$$${step.math}$$`), explanation.stopCondition].join("\n\n");
}
export function spanPrerequisiteExplanationText(context: z.infer<typeof spanPrerequisiteRepairContextSchema>, explanation: SpanTargetedExplanation): string {
  if (explanation.targetSkill !== context.targetSkill) throw new Error("先修短讲与当前安排不一致；未回退通用讲解。");
  return [context.focusSummary, "只补这一个有依据的先修步骤，再返回原要求；本块结果不代表已经掌握。", explanation.brief,
    ...explanation.workedSteps.map(step => `### ${step.label}\n\n$$${step.math}$$`), explanation.stopCondition].join("\n\n");
}
export function SpanTargetedExplanation({ context, explanation }: { context: SpanRepairContext; explanation: SpanTargetedExplanation }) {
  return <section aria-label="本题步骤短讲" className="space-y-4 rounded-xl border border-line p-4"><LearningProse text={spanTargetedExplanationText(context, explanation)} /></section>;
}
