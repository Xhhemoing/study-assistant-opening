import { z } from "zod";
import type { SpanAnswer } from "@aistudy/contracts";

export type SpanDraftAnswer = SpanAnswer & { explanation?: string };
const vector = z.array(z.string().max(160)).max(8);
const draftAnswerSchema = z.object({ membership: z.enum(["in_span", "not_in_span"]).optional(),
  coefficients: z.tuple([z.string().max(160), z.string().max(160)]).optional(),
  coordinateChecks: vector.optional(), equation: z.object({ vectors: z.tuple([vector, vector]), target: vector }).optional(),
  recognition: z.enum(["confirmed", "uncertain"]).optional(), explanation: z.string().max(6000).optional(),
  noSolutionWitness: vector.optional(), coefficientDerivationCoordinates: z.tuple([z.number().int().min(-1).max(7), z.number().int().min(-1).max(7)]).optional(),
  representations: z.object({ system: z.enum(["unique", "infinite", "none"]).optional(), geometry: z.enum(["plane", "line", "point"]).optional() }).optional(),
});
export function readSpanDraftAnswer(value: string): Partial<SpanDraftAnswer> {
  if (!value) return {};
  try { return draftAnswerSchema.safeParse(JSON.parse(value)).data ?? {}; }
  catch { return {}; }
}
export function spanVectorInput(value: string): string[] { return value.trim() ? value.split(/[,，]/).map(entry => entry.trim()) : []; }
export function updateSpanDraftAnswer(value: string, change: Partial<SpanDraftAnswer>): string {
  return JSON.stringify({ membership: "in_span", recognition: "confirmed", ...readSpanDraftAnswer(value), ...change });
}
export const SPAN_FEEDBACK_LABELS: Record<string, string> = {
  core_steps_unobserved: "请写出 αv+βw=u，并把求出的系数代回每个坐标。只有结论，还看不出你的解题思路。",
  no_solution_proof_unobserved: "要说明不属于 span，请指出哪个坐标出现矛盾。",
  verified_exactly: "你写出的等式、系数和坐标检查彼此一致，因此这个判断成立。",
  membership_incorrect: "判断的关键是：同一组系数能否让所有坐标同时成立？请把求出的系数代回最后一个坐标。",
  coefficients_do_not_satisfy_all_coordinates: "这组系数没有同时满足所有坐标。逐个算 αvᵢ+βwᵢ，并和 uᵢ 比较，找出第一个不相等的位置。",
  process_incorrect: "先看下面标出的步骤。检查是否抄错向量、系数的符号，或漏查了一个坐标。",
  answer_unparseable: "结构或数字无法识别，未计作数学错误。",
  unparseable_structure: "答案结构无法识别，未计作数学错误。",
  recognition_uncertain: "识别尚未确认，未计作数学错误。",
  coordinate_checks_incomplete: "坐标检查不完整，暂不判分。",
  coefficients_missing: "尚未提供可核对的系数，暂不判分。",
};
