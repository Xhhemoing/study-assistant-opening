import type { TeachingOutline } from "@aistudy/domain";
import { assertOutlineHonest } from "@aistudy/domain";

/** Stored extras are an unstructured database boundary, not a trusted TypeScript value. */
export function readStoredTeachingOutline(raw: unknown, activityId: string, sourceIds: readonly string[]): TeachingOutline | null {
  if (raw == null) return null;
  const fail = (): never => { throw new Error("已保存的教学大纲不可读取，请核对后重新生成。"); };
  if (typeof raw !== "object" || Array.isArray(raw)) return fail();
  const value = structuredClone(raw) as Record<string, unknown>;
  const strings = (input: unknown): input is string[] => Array.isArray(input) && input.every(item => typeof item === "string");
  if (value.kind !== "teaching_path" || value.activityId !== activityId || typeof value.outlineId !== "string"
    || typeof value.focusItemId !== "string" || !Array.isArray(value.items) || !value.items.length
    || !Array.isArray(value.prereqs)) return fail();
  const allowedSources = new Set(sourceIds);
  const itemIds = new Set<string>();
  for (const rawItem of value.items) {
    if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) return fail();
    const item = rawItem as Record<string, unknown>;
    if (typeof item.itemId !== "string" || !item.itemId || itemIds.has(item.itemId)
      || typeof item.title !== "string" || !item.title.trim() || !strings(item.goalIds)
      || !strings(item.intendedBlockTypes) || !strings(item.sourceIds)
      || item.notes !== undefined && typeof item.notes !== "string"
      || item.sourceIds.some(id => !allowedSources.has(id))
      || item.prereqItemIds !== undefined && !strings(item.prereqItemIds)) return fail();
    itemIds.add(item.itemId);
  }
  for (const rawPrereq of value.prereqs) {
    if (!rawPrereq || typeof rawPrereq !== "object" || Array.isArray(rawPrereq)) return fail();
    const prereq = rawPrereq as Record<string, unknown>;
    if (typeof prereq.itemId !== "string" || !itemIds.has(prereq.itemId)
      || typeof prereq.reason !== "string" || prereq.skippable !== true
      || !["continue_without", "mark_skipped"].includes(String(prereq.skipEffect))) return fail();
  }
  const outline = value as unknown as TeachingOutline;
  assertOutlineHonest(outline);
  return outline;
}
