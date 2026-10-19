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
  core_steps_unobserved: "本次结论可核对，但建立等式或全部坐标过程尚未观察到，整体 span 表现仍待检查。",
  no_solution_proof_unobserved: "不属于 span 的结论尚缺无解证据，未计作数学错误。",
  verified_exactly: "判断与已提交的数学步骤通过精确核对。",
  membership_incorrect: "是否属于 span 的判断与方程组相容性不一致。",
  coefficients_do_not_satisfy_all_coordinates: "这组系数没有同时满足所有坐标。",
  process_incorrect: "结论与过程需要分别核对：至少一个已填写步骤不一致。",
  answer_unparseable: "结构或数字无法识别，未计作数学错误。",
  unparseable_structure: "答案结构无法识别，未计作数学错误。",
  recognition_uncertain: "识别尚未确认，未计作数学错误。",
  coordinate_checks_incomplete: "坐标检查不完整，暂不判分。",
  coefficients_missing: "尚未提供可核对的系数，暂不判分。",
};
