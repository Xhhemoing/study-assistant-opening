import type { PlanDraft } from "@aistudy/contracts";

/** Only suggestions with a usable preview block can be accepted. */
export function selectableSuggestedKeys(draft: PlanDraft | null): string[] {
  if (!draft) return [];
  const scheduled = new Set(draft.blocks.map((block) => block.taskId));
  const unscheduled = new Set([...draft.unscheduledTaskIds, ...(draft.unscheduled ?? []).map((item) => item.taskId)]);
  return (draft.suggestedTasks ?? [])
    .filter((suggestion) => scheduled.has(suggestion.id) && !unscheduled.has(suggestion.id))
    .map((suggestion) => suggestion.key);
}

export function normalizeSuggestedSelection(draft: PlanDraft, selectedKeys: readonly string[]): string[] {
  const selected = new Set(selectedKeys);
  return selectableSuggestedKeys(draft).filter((key) => selected.has(key)).sort();
}

/** Retain choices for known suggestions after a reread; new usable suggestions start checked. */
export function reconcileSuggestedSelection(
  previous: PlanDraft | null,
  selectedKeys: readonly string[],
  next: PlanDraft | null,
): string[] {
  const known = new Set((previous?.suggestedTasks ?? []).map((suggestion) => suggestion.key));
  const selected = new Set(selectedKeys);
  return selectableSuggestedKeys(next).filter((key) => !known.has(key) || selected.has(key));
}
