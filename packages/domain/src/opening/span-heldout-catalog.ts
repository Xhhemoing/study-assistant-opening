/**
 * SERVER ONLY: reserved validation candidates; never import into teaching/client bundles.
 * These are development-reviewed candidates, not a claim of unexposed student evidence.
 * The actual delivery/debug ledger decides eligibility for each learner and protocol.
 */
import type { SpanProblem } from "@aistudy/contracts";
import { listGeneratedSpanItems, parseGeneratedSpanItem, spanProblemContentKey, type SpanItemPurpose } from "./span-generated-items";
export { spanProblemContentKey } from "./span-generated-items";
import { copyProblem, getSpanProblem, SPAN_KNOWLEDGE_COMPONENTS } from "./span-teaching-catalog";
/** Server-only teaching resolver. Research and reserved purposes are never teaching. */
export function getSpanTeachingProblem(id: string, version: string | number = "1"): SpanProblem | null {
  const fixed = getSpanProblem(id, version);
  if (fixed) return fixed;
  const item = parseGeneratedSpanItem(id, version);
  return item?.purpose === "teaching" ? item.problem : null;
}
export function listSpanWorkedProblems(): SpanProblem[] {
  return listGeneratedSpanItems("teaching").filter(problem => problem.familyId === "span:independent-2d");
}
const reserved: readonly SpanProblem[] = [
  { id: "span-reserved-fraction", version: "1", familyId: "span:rational-3d", vectors: [["2", "0", "1"], ["0", "3", "-1"]], target: ["1", "-2", "7/6"], knowledgeComponents: [...SPAN_KNOWLEDGE_COMPONENTS] },
  { id: "span-reserved-dependent", version: "1", familyId: "span:dependent-generators", vectors: [["2", "1", "-1"], ["6", "3", "-3"]], target: ["-4", "-2", "2"], knowledgeComponents: [...SPAN_KNOWLEDGE_COMPONENTS] },
  { id: "span-reserved-transfer", version: "1", familyId: "span:geometry-line", vectors: [["2", "-1", "1"], ["-4", "2", "-2"]], target: ["1", "1", "1"], knowledgeComponents: [...SPAN_KNOWLEDGE_COMPONENTS, "geometry:line-equation", "linear-system:consistency"], transfer: { fromFamilyId: "span:independent-2d", changes: ["从平面中的系数计算转为三维直线的几何约束；解释质量需单独验收"] } },
  // New identities: the historical parallel-q01..q08 source was not recovered.
  // Number changes retain their existing mathematical families and are not transfer claims.
  { id: "span-reserved-20261021-q01", version: "1", familyId: "span:independent-2d", vectors: [["2", "1"], ["1", "-1"]], target: ["1", "5"], knowledgeComponents: [...SPAN_KNOWLEDGE_COMPONENTS] },
  { id: "span-reserved-20261021-q02", version: "1", familyId: "span:consistent-3d", vectors: [["1", "2", "-1"], ["2", "-1", "3"]], target: ["-1", "-7", "6"], knowledgeComponents: [...SPAN_KNOWLEDGE_COMPONENTS] },
  { id: "span-reserved-20261021-q03", version: "1", familyId: "span:inconsistent-3d", vectors: [["1", "0", "2"], ["0", "1", "-1"]], target: ["3", "2", "5"], knowledgeComponents: [...SPAN_KNOWLEDGE_COMPONENTS] },
  { id: "span-reserved-20261021-q04", version: "1", familyId: "span:dependent-generators", vectors: [["2", "-1", "3"], ["-4", "2", "-6"]], target: ["5", "-5/2", "15/2"], knowledgeComponents: [...SPAN_KNOWLEDGE_COMPONENTS] },
  { id: "span-reserved-20261021-q05", version: "1", familyId: "span:rational-3d", vectors: [["3", "0", "-2"], ["0", "4", "1"]], target: ["-1", "3", "17/12"], knowledgeComponents: [...SPAN_KNOWLEDGE_COMPONENTS] },
  { id: "span-reserved-20261021-q06", version: "1", familyId: "span:geometry-plane", vectors: [["1", "0", "2"], ["0", "1", "-1"]], target: ["-2", "3", "-7"], knowledgeComponents: [...SPAN_KNOWLEDGE_COMPONENTS, "linear-system:consistency", "geometry:plane-equation"] },
  { id: "span-reserved-20261021-q07", version: "1", familyId: "span:geometry-line", vectors: [["1", "2", "-1"], ["3", "6", "-3"]], target: ["2", "4", "-1"], knowledgeComponents: [...SPAN_KNOWLEDGE_COMPONENTS, "geometry:line-equation", "linear-system:consistency"] },
  { id: "span-reserved-20261021-q08", version: "1", familyId: "span:dependent-generators", vectors: [["0", "0", "0"], ["2", "-4", "6"]], target: ["-1", "2", "-3"], knowledgeComponents: [...SPAN_KNOWLEDGE_COMPONENTS] },
];
export function listSpanReservedProblems(purpose?: "validation" | "retest"): SpanProblem[] {
  return purpose ? [...(purpose === "validation" ? reserved.map(copyProblem) : []), ...listGeneratedSpanItems(purpose)] : reserved.map(copyProblem);
}
/** Negative history may recognize every purpose; ordinary execution must not. */
export function getSpanItemIdentity(id: string, version: string | number = "1"): { problem: SpanProblem; purpose: SpanItemPurpose } | null {
  const fixed = reserved.find(candidate => candidate.id === id && candidate.version === String(version));
  return fixed ? { problem: copyProblem(fixed), purpose: "validation" } : parseGeneratedSpanItem(id, version);
}
export function getSpanReservedProblem(id: string, version: string | number = "1"): SpanProblem | null {
  const item = getSpanItemIdentity(id, version);
  return item && (item.purpose === "validation" || item.purpose === "retest") ? item.problem : null;
}
export type SpanValidationExposure = { itemId: string; itemVersion: string; familyId: string; contentKey?: string; use: "demonstration" | "hint" | "answer" | "debug" | "prompt_tuning" | "independent_answer"; releasedAt: string };
/** ID/number changes alone never establish transfer or an unseen question family. */
export function spanValidationEligibility(problem: SpanProblem, exposures: readonly SpanValidationExposure[], historyComplete = false): { eligible: boolean; reasons: string[]; unseenFamily: boolean } {
  if (!historyComplete) return { eligible: false, reasons: ["exposure_history_unknown"], unseenFamily: false };
  const key = spanProblemContentKey(problem);
  const sameItem = exposures.filter((entry) => (entry.itemId === problem.id && entry.itemVersion === problem.version)
    || (entry.contentKey ?? (getSpanItemIdentity(entry.itemId, entry.itemVersion) ? spanProblemContentKey(getSpanItemIdentity(entry.itemId, entry.itemVersion)!.problem) : null)) === key);
  const reasons = sameItem.map((entry) => `previous_${entry.use}`);
  return { eligible: reasons.length === 0, reasons: [...new Set(reasons)], unseenFamily: !exposures.some((entry) => entry.familyId === problem.familyId) };
}
