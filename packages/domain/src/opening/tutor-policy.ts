import type { TutorMode } from "@aistudy/contracts";
import { canBecomeObservedIndependent } from "@aistudy/contracts";
import { inferLearningMessageIntent, requestsFinalAnswer } from "./composer-intent";
import {
  isAdaptiveTutorRecommendInput,
  recommendAdaptiveTutorAction,
  type AdaptiveTutorActionKind,
  type AdaptiveTutorRecommendInput,
} from "./tutor-policy-adaptive";

export type { AdaptiveTutorActionKind, AdaptiveTutorRecommendInput } from "./tutor-policy-adaptive";
export { recommendAdaptiveTutorAction, isAdaptiveTutorRecommendInput } from "./tutor-policy-adaptive";

/** Modes accepted by K02a deepen path; aliases map onto T03 TutorMode. */
export type DeepenTutorMode = TutorMode | "guided" | "worked_example";

export type ThinTutorActionKind =
  | "clarify"
  | "guided"
  | "worked_example"
  | "independent_variant"
  | "delayed_retest";

export type ThinTutorAction = {
  kind: ThinTutorActionKind;
  skillLabel: string;
  currentPage: number | null;
  nodeId: string | null;
  problemRef: string | null;
  reason: string;
  evidenceIds: string[];
};

export type RecommendTutorActionInput = {
  skillLabel: string;
  currentPage: number | null;
  sourceIds: string[];
  nodeId?: string | null;
  problemRef?: string | null;
  sessionExposures: ReadonlyArray<"hinted" | "revealed">;
  assistedSuccessOnCurrentItem: boolean;
  retestDue: boolean;
  evidenceIds?: string[];
};

export function normalizeDeepenMode(mode: DeepenTutorMode): TutorMode {
  if (mode === "guided") return "hint";
  if (mode === "worked_example") return "explain";
  return mode;
}

export function exposureLevelForMode(
  mode: DeepenTutorMode,
): "hinted" | "revealed" | null {
  const normalized = normalizeDeepenMode(mode);
  if (normalized === "hint") return "hinted";
  if (normalized === "explain") return "revealed";
  return null;
}

/** hint/guided = next-step only; explain/worked_example = full + reveal. */
const CITE_WHEN_MATERIALS =
  " 若提供了材料片段且作答依据它们，请在 citedChunkIds 列出支持性 chunk id；纯一般说明可用空数组。系统中的课程、计划、任务状态和学习资格必须依据当前已核验的查询回执；历史聊天不证明当前状态。未提供当前回执时明确说明本轮无法核实，建议重试该状态问题；不得编造系统读取或掌握结论。";
const TEACHING_FLOW = "先理解学生想完成什么和已经尝试的步骤。需要练习时，先给足以推进一步的最小提示；已有推导时先回应具体卡点。讲清后用一道改变条件的变式检验理解，并逐步减少帮助。遵守本轮已选模式：hint 不给剩余完整推导；explain 直接展开，不再次强迫作答或重复起步选择。遇到英文题可先用中文解释题意，再用英文呈现主要推导与关键术语。";

export function makeTutorInstruction(mode: DeepenTutorMode, message?: { text: string }): string {
  const learning = message ? inferLearningMessageIntent(message.text) : "general";
  const next = learning === "frustrated" ? "先用一句具体、简短的话回应卡住的感受，不评判能力；给出可选退路：看一个示例、换一道简单题、或先跳过。等待学生选择，不强迫继续、不替学生标记完成。"
    : learning === "skip" ? "接受学生想跳过的选择，不要求解释理由；询问要换一个简短例子还是先休息。不要声称已修改学习记录或把未做题标为完成。"
      : learning === "submit_attempt" ? "先检查学生已经写出的答案或步骤：答对就说明关键理由，答错就指出第一个出错步骤及原因，再给一个最小修正动作。题干不足时只补问缺失条件，不凭聊天写入正式批改或掌握记录。"
        : message && requestsFinalAnswer(message.text) && normalizeDeepenMode(mode) === "hint"
          ? "学生第一次请求本题答案：先给两个简短的起步方向，一个可行、一个体现常见误区，请学生选一个；此轮不揭示正误、最终答案或剩余推导。选择后解释原因并推进一步。学生可随时选“直接讲完整”，不要反复要求二选一。" : "";
  const flow = next + TEACHING_FLOW + CITE_WHEN_MATERIALS;
  switch (normalizeDeepenMode(mode)) {
    case "listen":
      return "倾听并确认理解，用一个具体问题找准学习目标；不要自动创建任务。" + flow;
    case "hint":
      return "提供一个下一步提示（next-step hint），解释为什么这一步有用，让学生继续完成；本轮保留最终完整答案和剩余推导供学生尝试。" + flow;
    case "explain":
      return "给出完整答案与完整解题过程（worked example），逐步解释选择方法的原因，围绕已知错因做对比，再给一道简短变式。" + flow;
    case "think_together":
      return "与学习者共同思考，比较可行路径，让学生选择并说明理由；需要调整计划时先提出建议。" + flow;
  }
}

export function marksReveal(mode: DeepenTutorMode): boolean {
  return exposureLevelForMode(mode) === "revealed";
}

export function citationsMatchPhysicalPage(
  citations: ReadonlyArray<{ page: number | null | undefined }>,
  currentPage: number,
): boolean {
  return (
    citations.length > 0 &&
    citations.every((c) => c.page === currentPage)
  );
}

export class PageCitationError extends Error {
  readonly code = "page_not_in_sources" as const;
  constructor(message = "page_not_in_sources") {
    super(message);
    this.name = "PageCitationError";
  }
}

/** Learner-facing Clarify prompt stored on a refused page-backed turn (LAB-A01). */
export const PAGE_CITATION_CLARIFY_MESSAGE =
  "无法把回答锚定到所选材料的当前页，本轮已拒答。请重新选择材料和页码（或确认页码是否正确）后再问。";

/**
 * require_page refusal that routes to Clarify (pick the material/page)
 * instead of a generic failure. Still a PageCitationError, so it never
 * completes a turn or writes help exposure (LAB-A01).
 */
export class PageCitationClarifyError extends PageCitationError {
  readonly nextAction = "clarify" as const;
  constructor() {
    super(PAGE_CITATION_CLARIFY_MESSAGE);
    this.name = "PageCitationClarifyError";
  }
}

/**
 * Prefer citations on the sticky physical page when any match.
 * Empty cites stay empty (general answer OK). Off-page-only cites are kept
 * rather than failing the turn — hard throws for invented selection pages
 * remain in page-selection validation.
 */
export function preferCitationsForPage<T extends { page?: number | null }>(
  citations: readonly T[],
  currentPage: number,
): T[] {
  if (citations.length === 0) return [];
  const onPage = citations.filter((c) => c.page === currentPage);
  return onPage.length > 0 ? onPage.slice() : citations.slice();
}

/**
 * Soft page guard (cite Package D): empty cites with currentPage do not throw
 * (general answers are allowed). Off-page cites are filtered via
 * preferCitationsForPage at the call site. Kept for call-site compatibility;
 * never fails the turn solely for empty or off-page cites.
 */
export function assertCitationsForPage(
  citations: ReadonlyArray<{ page: number | null | undefined }>,
  currentPage: number,
): void {
  // Soft: empty = general OK; off-page handled by preferCitationsForPage.
  void citations;
  void currentPage;
}

export function variantProblemRef(
  assistedProblemRef: string,
  variantSuffix = ":variant",
): string {
  const base = assistedProblemRef.trim();
  if (!base) return `variant${variantSuffix}`;
  if (base.endsWith(variantSuffix)) return `${base}-2`;
  return `${base}${variantSuffix}`;
}

export function assistedItemBlocksIndependent(input: {
  assistedProblemRef: string | null | undefined;
  answerProblemRef: string | null | undefined;
  assistance: "independent" | "hinted" | "revealed" | "unknown";
  outcome: "correct" | "incorrect" | "unverified";
}): boolean {
  if (
    input.assistedProblemRef &&
    input.answerProblemRef &&
    input.assistedProblemRef === input.answerProblemRef
  ) {
    return true;
  }
  return !canBecomeObservedIndependent(input.assistance, input.outcome);
}

/** Thin recommend: page + skillLabel (+ optional nodeId). No K01 required.
 *  Overload: K02 nodeId path returns TutorAction kind (adaptive decision order).
 */
export function recommendTutorAction(
  input: AdaptiveTutorRecommendInput,
): AdaptiveTutorActionKind;
export function recommendTutorAction(
  input: RecommendTutorActionInput,
): ThinTutorAction;
export function recommendTutorAction(
  input: AdaptiveTutorRecommendInput | RecommendTutorActionInput,
): AdaptiveTutorActionKind | ThinTutorAction {
  if (isAdaptiveTutorRecommendInput(input)) {
    return recommendAdaptiveTutorAction(input);
  }
  const skillLabel = input.skillLabel.trim();
  if (!skillLabel) throw new Error("skillLabel is required");
  const base = {
    skillLabel,
    currentPage: input.currentPage,
    nodeId: input.nodeId ?? null,
    evidenceIds: input.evidenceIds ?? [],
  };
  const problemRef = input.problemRef ?? null;

  if (input.retestDue) {
    return {
      ...base,
      kind: "delayed_retest",
      problemRef,
      reason: "L02 delayed retest is due; start a new session with empty exposure.",
    };
  }
  if (input.assistedSuccessOnCurrentItem && problemRef) {
    return {
      ...base,
      kind: "independent_variant",
      problemRef: variantProblemRef(problemRef),
      reason:
        "Assisted success on the current item; try a new independent variant.",
    };
  }
  if (input.sessionExposures.includes("revealed")) {
    return {
      ...base,
      kind: "independent_variant",
      problemRef: problemRef ? variantProblemRef(problemRef) : "variant:1",
      reason: "Full explain already delivered; next step is a new item.",
    };
  }
  // V2-11: escalate-after-hint is a *suggestion* only. Callers must run
  // decideIntervention / gateTutorRecommendAfterDecision before surface or auto-act;
  // decision forbids auto `respond` from hint alone (max offer unless user_help_ask).
  if (input.sessionExposures.includes("hinted")) {
    return {
      ...base,
      kind: "worked_example",
      problemRef,
      reason: "Hint delivered; offer a full worked example if still stuck.",
    };
  }
  if (input.currentPage == null) {
    return {
      ...base,
      kind: "clarify",
      problemRef,
      reason: "No current page selected; clarify the target material/page first.",
    };
  }
  return {
    ...base,
    kind: "guided",
    problemRef,
    reason: "Material page selected; start with a next-step guided hint.",
  };
}

export function assertNoMasteryPercentage(
  payload: Record<string, unknown>,
): void {
  for (const key of [
    "mastery",
    "masteryPercent",
    "masteryPercentage",
    "mastery_pct",
  ]) {
    if (key in payload) {
      throw new Error(`mastery percentage field forbidden: ${key}`);
    }
  }
}

export function freshRetestExposure(): [] {
  return [];
}
