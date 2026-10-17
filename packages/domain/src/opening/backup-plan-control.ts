import { assistantCandidateSchema, conversationPlanMetadataSchema, coachPlanUndoResultSchema, localReplanMetadataSchema, suggestedTaskSchema, suggestionFeedbackInputSchema, taskItemSchema } from "@aistudy/contracts";
import { suggestionFeedbackIdentity } from "./adaptive/suggestion-feedback";
import { localReplanFixedBlocks, samePlannedBlocks } from "./adaptive/local-replan";
import { isRecord, isUuid } from "./backup-validation";

type Tables = Record<string, Record<string, unknown>[]>;
const dateKey = (value: unknown) => value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);

/** Imported planning metadata must point to the same included owner, task and draft. */
export function validateBackupPlanControl(tables: Tables, errors: string[]): void {
  const drafts = new Map((tables.opening_plan_drafts ?? []).map(row => [row.id, row]));
  const candidates = new Map((tables.opening_assistant_candidates ?? []).map(row => [row.id, row]));
  const conversations = new Map((tables.opening_conversations ?? []).map(row => [row.id, row]));
  const tasks = new Map((tables.opening_tasks ?? []).map(row => [row.id, row]));
  const clients = new Set<string>(), identities = new Set<string>(), ids = new Set<string>();
  for (const row of tables.opening_suggestion_feedback ?? []) {
    const draft = drafts.get(row.draft_id);
    const suggestions = suggestedTaskSchema.array().safeParse(draft?.suggested_tasks);
    const suggestion = suggestions.success ? suggestions.data.find(item => item.key === row.suggestion_key) : undefined;
    const intent = suggestionFeedbackInputSchema.safeParse(isRecord(row.intent) ? { ...row.intent, clientKey: row.client_key } : null);
    const client = `${row.workspace_id}/${row.owner_user_id}/${row.client_key}`;
    const identity = `${row.workspace_id}/${row.owner_user_id}/${dateKey(row.day)}/${row.identity}`;
    if (!isUuid(row.id) || ids.has(String(row.id)) || clients.has(client) || identities.has(identity)
      || !draft || draft.workspace_id !== row.workspace_id || draft.owner_user_id !== row.owner_user_id || draft.origin === "agent"
      || dateKey(draft.day) !== dateKey(row.day) || !suggestion || row.identity !== suggestionFeedbackIdentity(suggestion)
      || row.suggestion_kind !== suggestion.kind || (row.course_id !== null && row.course_id !== suggestion.courseId)
      || row.requirement_key !== (suggestion.requirementKey ?? null) || !Number.isFinite(Date.parse(String(row.recorded_at)))
      || !intent.success || intent.data.draftId !== row.draft_id || intent.data.suggestionKey !== row.suggestion_key
      || (intent.data.reason ?? null) !== row.reason) errors.push("suggestion feedback identity, scope or draft relation is invalid");
    ids.add(String(row.id)); clients.add(client); identities.add(identity);
  }
  for (const draft of drafts.values()) {
    const snapshot = isRecord(draft.input_snapshot) ? draft.input_snapshot : null;
    if (draft.origin === "agent") {
      const metadata = conversationPlanMetadataSchema.safeParse(snapshot?.conversationPlan);
      const candidate = metadata.success ? candidates.get(metadata.data.candidateId) : undefined;
      const conversation = candidate ? conversations.get(candidate.conversation_id) : undefined;
      const payload = assistantCandidateSchema.safeParse(candidate?.payload);
      if (!metadata.success || !candidate || !conversation || conversation.owner_user_id !== draft.owner_user_id
        || candidate.workspace_id !== draft.workspace_id || candidate.source_turn_id !== metadata.data.sourceTurnId
        || !payload.success || payload.data.kind !== "task" || payload.data.title !== metadata.data.title
        || (payload.data.dueText === "" ? null : payload.data.dueText) !== metadata.data.dueText
        || (payload.data.minutes !== null && payload.data.minutes !== metadata.data.minutes)
        || !Array.isArray(candidate.source_ids)
        || JSON.stringify([...candidate.source_ids].sort()) !== JSON.stringify([...metadata.data.sourceIds].sort())) {
        errors.push("conversation plan candidate or source lineage is unavailable");
      }
    }
    if (draft.strategy_version !== "local-replan-v1" && snapshot?.localReplan === undefined) continue;
    const metadata = localReplanMetadataSchema.safeParse(snapshot?.localReplan);
    const savedTasks = taskItemSchema.array().safeParse(snapshot?.tasks);
    if (!metadata.success || !savedTasks.success || draft.strategy_version !== "local-replan-v1"
      || metadata.data.baseAcceptedVersion !== draft.base_version
      || savedTasks.data.some(task => !task.version) || new Set(savedTasks.data.map(task => task.id)).size !== savedTasks.data.length) {
      errors.push("local replan snapshot is invalid"); continue;
    }
    const fixed = localReplanFixedBlocks({ acceptedBlocks: metadata.data.baselineBlocks, tasks: savedTasks.data,
      now: new Date(metadata.data.proposedAt), preserveAll: metadata.data.preserveAll });
    if (!samePlannedBlocks(fixed.fixedBlocks, metadata.data.fixedBlocks)) errors.push("local replan preserved baseline is invalid");
  }
  const undoKeys = new Set<string>();
  for (const receipt of tables.opening_plan_acceptances ?? []) {
    if (receipt.source === undefined) continue; // Historical receipt has no undo authority.
    const draft = drafts.get(receipt.draft_id);
    if (!draft || draft.workspace_id !== receipt.workspace_id || !["learner", "coach"].includes(String(receipt.source))) {
      errors.push("plan acceptance scope or source is invalid"); continue;
    }
    const versions = receipt.created_task_versions;
    const proposal = suggestedTaskSchema.array().safeParse(draft.suggested_tasks ?? []);
    if (!isRecord(versions) || Object.entries(versions).some(([id, version]) => {
      const task = tasks.get(id);
      const suggestion = proposal.success ? proposal.data.find(item => item.id === id) : undefined;
      const invalidCoachTask = receipt.source === "coach" && (!suggestion || task?.origin !== "planner"
        || task.client_key !== suggestion.key || task.course_id !== suggestion.courseId
        || task.requirement_key !== (suggestion.requirementKey ?? null));
      return invalidCoachTask || !task || task.workspace_id !== draft.workspace_id || task.owner_user_id !== draft.owner_user_id
        || !Number.isSafeInteger(version) || Number(version) < 1 || Number(version) > Number(task.version);
    })) errors.push("plan acceptance created tasks are invalid");
    if (receipt.source === "coach" && (!Array.isArray(receipt.before_blocks) || receipt.before_blocks.length !== 0
      || draft.origin !== "auto_draft" || Number(draft.base_version) !== 0)) errors.push("coach acceptance baseline is invalid");
    if (receipt.undone_at != null) {
      const result = coachPlanUndoResultSchema.safeParse(receipt.undo_result);
      const key = `${receipt.workspace_id}/${receipt.undo_client_key}`;
      if (!result.success || !isRecord(receipt.undo_intent) || typeof receipt.undo_client_key !== "string" || undoKeys.has(key)
        || result.data.acceptedVersion !== Number(receipt.undo_result_version)
        || result.data.acceptedVersion !== Number(receipt.accepted_version) + 1
        || result.data.closedTaskIds.some(id => !isRecord(versions) || !(id in versions))) errors.push("coach undo receipt is invalid");
      undoKeys.add(key);
    }
  }
}
