import type { PlanDraftOrigin, PlannedBlock, PlanningAutonomy, SuggestedTask } from "@aistudy/contracts";
import { canReorderTask, getGuidancePolicy, type GuidanceMode } from "../../guidance/guidance";

/** UX policy §3 modes onto the guidance policy that already encodes their permissions. */
export function autonomyGuidanceMode(autonomy: PlanningAutonomy): GuidanceMode {
  if (autonomy === "manual") return "free";
  if (autonomy === "copilot") return "advisory";
  return "coach";
}

export type CoachDecisionInput = {
  autonomy: PlanningAutonomy;
  /** Local day of the draft and the workspace's current local day. */
  date: string;
  today: string;
  /** Current accepted version for the day and the origin of the draft behind it. */
  acceptedVersion: number;
  acceptedOrigin: PlanDraftOrigin | null;
  draft: {
    status: "draft" | "accepted" | "rejected";
    origin?: PlanDraftOrigin;
    blocks: readonly PlannedBlock[];
    suggestedTasks?: readonly SuggestedTask[];
  };
  budgetMinutes: number;
};

export type CoachDenyReason = "not_coach" | "not_today" | "not_open" | "not_auto_draft" | "user_confirmed";

export type CoachDecision =
  | { allow: true; acceptKeys: string[]; addedMinutes: number }
  | { allow: false; reason: CoachDenyReason };

/**
 * Whether the coach may confirm today's automatic draft by itself, and which
 * suggestions it may create. It never touches another day, a version the learner
 * confirmed, or a draft it did not produce (model drafts always need the learner);
 * suggestions are admitted in draft order while their minutes fit the budget.
 */
export function decideCoachAutoAccept(input: CoachDecisionInput): CoachDecision {
  if (input.autonomy !== "coach") return { allow: false, reason: "not_coach" };
  if (input.date !== input.today) return { allow: false, reason: "not_today" };
  if (input.draft.status !== "draft") return { allow: false, reason: "not_open" };
  if (input.draft.origin !== "auto_draft") return { allow: false, reason: "not_auto_draft" };
  if (input.acceptedVersion > 0 && input.acceptedOrigin !== "coach") return { allow: false, reason: "user_confirmed" };

  const policy = getGuidancePolicy(autonomyGuidanceMode(input.autonomy));
  const scheduled = new Set(input.draft.blocks.map((block) => block.taskId));
  let remaining = input.budgetMinutes;
  const acceptKeys: string[] = [];
  for (const suggestion of input.draft.suggestedTasks ?? []) {
    if (!scheduled.has(suggestion.id)) continue;
    const target = { isHistory: false, isConfirmed: false, isLocked: false, estimatedMinutes: suggestion.minutes };
    if (!canReorderTask(policy, target, remaining)) continue;
    remaining -= suggestion.minutes;
    acceptKeys.push(suggestion.key);
  }
  return { allow: true, acceptKeys, addedMinutes: input.budgetMinutes - remaining };
}
