import {
  observationRevisionInputSchema,
  type LearningObservation,
  type ObservationRevisionInput,
} from "@aistudy/contracts";
import { OpeningApiError } from "../client/api";

export const SELF_COMPARE_REASON = "对照参考核对";
export const SELF_COMPARE_METHOD_PREFIX = "learner_self_compare";

export type SelfCompareChoice = "match" | "partial" | "mismatch" | "unclear";
export type DeliveredAssistance = "none" | "hinted" | "revealed";
export type AssistanceChoice = LearningObservation["assistance"];

const ASSISTANCE_RANK: Record<AssistanceChoice, number> = {
  unknown: 0,
  independent: 0,
  hinted: 1,
  revealed: 2,
};

/** Map GET deliveredAssistance into the form's assistance floor (none → no floor). */
export function deliveredAssistanceRank(delivered: DeliveredAssistance): number {
  if (delivered === "revealed") return 2;
  if (delivered === "hinted") return 1;
  return 0;
}

/** Prefill help level from server-delivered exposures; client may only raise later. */
export function preselectAssistance(delivered: DeliveredAssistance): AssistanceChoice {
  if (delivered === "revealed") return "revealed";
  if (delivered === "hinted") return "hinted";
  return "unknown";
}

export function isAssistanceAllowed(option: AssistanceChoice, delivered: DeliveredAssistance): boolean {
  return ASSISTANCE_RANK[option] >= deliveredAssistanceRank(delivered);
}

/** Never lower below the server-delivered floor; may only raise. */
export function raiseAssistanceOnly(
  selected: AssistanceChoice,
  delivered: DeliveredAssistance,
): AssistanceChoice {
  const rank = Math.max(ASSISTANCE_RANK[selected], deliveredAssistanceRank(delivered));
  if (rank >= 2) return "revealed";
  if (rank >= 1) return ASSISTANCE_RANK[selected] >= 2 ? "revealed" : "hinted";
  return selected;
}

export function buildSelfCompareMethod(page?: number | null): string {
  if (page != null && Number.isInteger(page) && page > 0) {
    return `${SELF_COMPARE_METHOD_PREFIX} 第${page}页`;
  }
  return SELF_COMPARE_METHOD_PREFIX;
}

/**
 * Second-step revision: same answer + referenceCheck.
 * "unclear" (看不懂参考) returns null — no request; keep self_report.
 */
export function buildSelfCompareRevision(input: {
  observation: Pick<
    LearningObservation,
    "id" | "rootObservationId" | "answer" | "assistance" | "courseId" | "skillLabel" | "requirementKey"
  >;
  referenceSourceId: string;
  choice: SelfCompareChoice;
  page?: number | null;
  clientKey: string;
}): ObservationRevisionInput | null {
  if (input.choice === "unclear") return null;
  const scope = input.choice === "partial" ? "partial" : "whole_answer";
  const outcome =
    input.choice === "match" ? "correct" : input.choice === "mismatch" ? "incorrect" : "unverified";
  const headId = input.observation.id;
  return observationRevisionInputSchema.parse({
    rootObservationId: input.observation.rootObservationId ?? headId,
    revisesObservationId: headId,
    expectedHead: headId,
    revisionKind: "replace",
    reason: SELF_COMPARE_REASON,
    clientKey: input.clientKey,
    replacement: {
      answer: input.observation.answer,
      outcome,
      assistance: input.observation.assistance,
      courseId: input.observation.courseId,
      skillLabel: input.observation.skillLabel,
      requirementKey: input.observation.requirementKey ?? null,
      verdictSource: "reference_checked",
      referenceSourceId: input.referenceSourceId,
      referenceCheck: {
        referenceSourceId: input.referenceSourceId,
        method: buildSelfCompareMethod(input.page),
        scope,
      },
    },
  });
}

/** Stable clientKey for one self-compare intent (choice + page + head). */
export function selfCompareRevisionIntentKey(
  observationId: string,
  choice: SelfCompareChoice,
  page: number | null | undefined,
): string {
  return JSON.stringify([observationId, choice, page ?? null]);
}

export function referenceCheckFailure(error: unknown): {
  kind: "conflict" | "unavailable" | "error";
  message: string;
} {
  if (error instanceof OpeningApiError && error.status === 409) {
    return {
      kind: "conflict",
      message: "记录已被更新。请重新读取后再对照参考核对。",
    };
  }
  if (error instanceof OpeningApiError && (error.status === 403 || error.status === 404)) {
    return {
      kind: "unavailable",
      message: "这条记录已不可用，已停止展示。请刷新课程记录。",
    };
  }
  return {
    kind: "error",
    message: error instanceof Error ? error.message : "对照参考核对失败，答案未改动，请重试。",
  };
}
