/**
 * SERVER ONLY: reserved validation candidates; never import into teaching/client bundles.
 * These are development-reviewed candidates, not a claim of unexposed student evidence.
 * The actual delivery/debug ledger decides eligibility for each learner and protocol.
 */
import type { SpanProblem } from "@aistudy/contracts";
import { copyProblem, SPAN_KNOWLEDGE_COMPONENTS } from "./span-teaching-catalog";
const reserved: readonly SpanProblem[] = [
  { id: "span-reserved-fraction", version: "1", familyId: "span:rational-3d", vectors: [["2", "0", "1"], ["0", "3", "-1"]], target: ["1", "-2", "7/6"], knowledgeComponents: [...SPAN_KNOWLEDGE_COMPONENTS] },
  { id: "span-reserved-dependent", version: "1", familyId: "span:dependent-generators", vectors: [["2", "1", "-1"], ["6", "3", "-3"]], target: ["-4", "-2", "2"], knowledgeComponents: [...SPAN_KNOWLEDGE_COMPONENTS] },
  { id: "span-reserved-transfer", version: "1", familyId: "span:geometry-line", vectors: [["2", "-1", "1"], ["-4", "2", "-2"]], target: ["1", "1", "1"], knowledgeComponents: [...SPAN_KNOWLEDGE_COMPONENTS, "geometry:line-equation", "linear-system:consistency"], transfer: { fromFamilyId: "span:independent-2d", changes: ["从平面中的系数计算转为三维直线的几何约束；解释质量需单独验收"] } },
];
export function listSpanReservedProblems(): SpanProblem[] { return reserved.map(copyProblem); }
export function getSpanReservedProblem(id: string, version: string | number = "1"): SpanProblem | null {
  const problem = reserved.find((candidate) => candidate.id === id && candidate.version === String(version));
  return problem ? copyProblem(problem) : null;
}
export type SpanValidationExposure = { itemId: string; itemVersion: string; familyId: string; use: "demonstration" | "hint" | "answer" | "debug" | "prompt_tuning" | "independent_answer"; releasedAt: string };
/** ID/number changes alone never establish transfer or an unseen question family. */
export function spanValidationEligibility(problem: SpanProblem, exposures: readonly SpanValidationExposure[], historyComplete = false): { eligible: boolean; reasons: string[]; unseenFamily: boolean } {
  if (!historyComplete) return { eligible: false, reasons: ["exposure_history_unknown"], unseenFamily: false };
  const sameItem = exposures.filter((entry) => entry.itemId === problem.id && entry.itemVersion === problem.version);
  const reasons = sameItem.map((entry) => `previous_${entry.use}`);
  return { eligible: reasons.length === 0, reasons: [...new Set(reasons)], unseenFamily: !exposures.some((entry) => entry.familyId === problem.familyId) };
}
