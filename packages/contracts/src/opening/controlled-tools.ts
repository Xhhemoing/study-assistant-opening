import { z } from "zod";
import { uuidSchema } from "./foundation";
import { spanLessonSnapshotSchema } from "./span-session";
import { sourceChunkSchema } from "./sources";
import { assistantProposalCreateSchema, assistantProposalDecisionSchema, assistantProposalRecordSchema } from "./assistant-proposals";
import { coachPlanAcceptInputSchema, coachPlanAcceptResultSchema, coachPlanUndoInputSchema, coachPlanUndoResultSchema } from "./coach-plans";

export const spanNextActionInputSchema = z.object({ activityId: uuidSchema, expectedRevision: z.number().int().positive(),
  observationId: uuidSchema.nullable(), clientKey: z.string().min(8).max(160) }).strict();
export const spanDelayedRetestInputSchema = z.object({ observationId: uuidSchema, clientKey: z.string().min(8).max(160) }).strict();
export const spanAutomaticRetestInputSchema = spanDelayedRetestInputSchema.extend({ expectedGrantRevision: z.number().int().nonnegative() });
export const spanDelayedRetestResultSchema = z.object({ candidateId: uuidSchema, taskId: uuidSchema, activityId: uuidSchema,
  courseId: uuidSchema, notBeforeAt: z.string().datetime(), taskStatus: z.string(), activityStatus: z.string(), href: z.string() }).strict();

/** Descriptions bind to native owners, not a second authorization or execution ledger. */
export const controlledLearningTools = {
  cancel_retest: { input: z.object({ activityId: uuidSchema }).strict(),
    output: z.object({ activityId: uuidSchema, cancelled: z.boolean(), closedTaskIds: z.array(uuidSchema) }).strict(), permission: "confirmation_required",
    scope: "owned_workspace_automatic_retest", idempotency: "activityId_terminal_status",
    undo: "none_history_and_consumed_cost_retained" },
  next_question: { input: spanNextActionInputSchema, output: spanLessonSnapshotSchema, permission: "automatic",
    scope: "owned_workspace_course_sources", idempotency: "span-next:activityId:observationId / span-tutor-decision:operationId",
    undo: "none_started_activity_history_retained" },
  resume_activity: { input: uuidSchema, output: spanLessonSnapshotSchema, permission: "automatic",
    scope: "owned_workspace_course_sources", idempotency: "activityId / original_operation_receipt",
    undo: "none_read_existing_activity" },
  schedule_retest: { input: spanAutomaticRetestInputSchema, output: spanDelayedRetestResultSchema, permission: "automatic",
    scope: "owned_workspace_course_sources", idempotency: "accept_client_key / baseline_observation",
    undo: "cancelOwnedSpanTutorRetests:automatic_owned_unstarted_unedited_unaccepted" },
  open_fragment: { input: uuidSchema, output: sourceChunkSchema.array(), permission: "automatic",
    scope: "owned_workspace_uploaded_source", idempotency: "sourceId:sourceVersion:chunkId_read_only",
    undo: "none_read_only" },
  plan_draft: { input: assistantProposalCreateSchema, output: assistantProposalRecordSchema, permission: "automatic",
    scope: "owned_workspace_source_turn", idempotency: "proposal.clientKey",
    undo: "reject_draft_via_decide" },
  accept_proposal: { input: assistantProposalDecisionSchema, output: assistantProposalRecordSchema, permission: "confirmation_required",
    scope: "owned_workspace_proposal_version_privacy_basis", idempotency: "decision.clientKey",
    undo: "native_effect_lifecycle" },
  accept_plan: { input: coachPlanAcceptInputSchema, output: coachPlanAcceptResultSchema, permission: "confirmation_required",
    scope: "owned_workspace_draft_version", idempotency: "acceptance.clientKey",
    undo: "undoOpeningCoachPlan:coach_owned_future_unstarted_unedited" },
  undo_plan: { input: coachPlanUndoInputSchema, output: coachPlanUndoResultSchema, permission: "confirmation_required",
    scope: "owned_workspace_acceptance_version", idempotency: "undo.clientKey",
    undo: "none_history_and_consumed_cost_retained" },
} as const;
export type ControlledLearningTool = keyof typeof controlledLearningTools;
export type ControlledToolPermission = "automatic" | "confirmation_required" | "forbidden";

/** Call after native admission. A global switch never supplies consent for a mutation. */
export function controlledLearningToolPermission(tool: string, input: {
  enabled: boolean; authorized: boolean; explicitlyConfirmed?: boolean;
}): ControlledToolPermission {
  if (!Object.hasOwn(controlledLearningTools, tool) || !input.enabled || !input.authorized) return "forbidden";
  const descriptor = controlledLearningTools[tool as ControlledLearningTool];
  if (descriptor.permission === "confirmation_required") return input.explicitlyConfirmed ? "automatic" : "confirmation_required";
  return input.authorized ? "automatic" : "forbidden";
}
