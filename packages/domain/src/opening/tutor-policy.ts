import type { TutorMode } from "@aistudy/contracts";
import { canBecomeObservedIndependent } from "@aistudy/contracts";
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
export function makeTutorInstruction(mode: DeepenTutorMode): string {
  switch (normalizeDeepenMode(mode)) {
    case "listen":
      return "倾听并确认理解；不要自动创建任务，不要擅自规划。";
    case "hint":
      return "只提供下一步提示（next-step hint），禁止直接给出最终完整答案或完整解题过程。引导学习者自己完成；若需要完整解答，应改用 explain / worked_example。";
    case "explain":
      return "允许给出完整答案与完整解题过程（worked example），并标明材料依据。完成后按 reveal 意图记录帮助暴露（revealed），不可当作独立掌握。";
    case "think_together":
      return "与学习者共同思考，提出问题和候选路径，不直接改变计划。";
  }
}

export function marksReveal(mode: DeepenTutorMode): boolean {
  return exposureLevelForMode(mode) === "revealed";
}

export function citationsMatchPhysicalPage(
  citations: ReadonlyArray<{ page: number | null }>,
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

export function assertCitationsForPage(
  citations: ReadonlyArray<{ page: number | null }>,
  currentPage: number,
): void {
  if (!citationsMatchPhysicalPage(citations, currentPage)) {
    throw new PageCitationError();
  }
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
