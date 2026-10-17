import { suggestionKindSchema, taskFeedbackReasonSchema, taskOriginSchema } from "@aistudy/contracts";
import { isUuid } from "./backup-validation";

/** Feedback can only refer to an included task belonging to the same owner. */
export function validateBackupPlanFeedback(tables: Record<string, Record<string, unknown>[]>, errors: string[]): void {
  const tasks = new Map((tables.opening_tasks ?? []).filter(row => isUuid(row.id))
    .map(row => [String(row.id).toLowerCase(), row]));
  const ids = new Set<string>(), actions = new Set<string>();
  const validDate = (value: unknown) => (typeof value === "string" || value instanceof Date)
    && Number.isFinite(new Date(value).getTime());
  for (const row of tables.opening_plan_feedback ?? []) {
    const task = isUuid(row.task_id) ? tasks.get(row.task_id.toLowerCase()) : undefined;
    if (!task || !isUuid(row.owner_user_id) || !isUuid(task.owner_user_id)
      || row.owner_user_id.toLowerCase() !== task.owner_user_id.toLowerCase()
      || !isUuid(row.workspace_id) || !isUuid(task.workspace_id)
      || row.workspace_id.toLowerCase() !== task.workspace_id.toLowerCase()) {
      errors.push("planning feedback has no task in the same workspace and owner");
    }
    const id = isUuid(row.id) ? row.id.toLowerCase() : null;
    const key = `${String(row.task_id).toLowerCase()}/${row.task_version}/${row.action}`;
    if (!id || ids.has(id) || actions.has(key)) errors.push("planning feedback identity is invalid or duplicated");
    if (id) ids.add(id);
    actions.add(key);
    if (!Number.isSafeInteger(row.task_version) || (row.task_version as number) < 1
      || !task || !Number.isSafeInteger(task.version) || (row.task_version as number) > (task.version as number)
      || !["done", "skipped", "deferred", "resumed"].includes(String(row.action))
      || !taskOriginSchema.safeParse(row.origin).success
      || (row.reason !== null && !taskFeedbackReasonSchema.safeParse(row.reason).success)
      || (row.suggestion_kind !== null && !suggestionKindSchema.safeParse(row.suggestion_kind).success)
      || (row.requirement_key !== null && (typeof row.requirement_key !== "string" || row.requirement_key.length > 200))
      || !validDate(row.recorded_at)
      || (row.not_before !== null && !validDate(row.not_before))
      || (row.action === "deferred" && row.not_before === null)
      || (row.action === "resumed" && row.not_before !== null)) {
      errors.push("planning feedback fields or task version are invalid");
    }
  }
}
