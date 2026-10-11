/**
 * V2-08 teaching plan — outline / path / prereq types and guards.
 * Pure domain: no provider I/O, no planDay calendar coupling, no mastery % locks.
 */
import { assertNoMasteryPercentage } from "./tutor-policy";

/** M1 allowlist — program constrains model; Experience may subset further. */
export const ALLOWED_TEACHING_BLOCK_TYPES = [
  "text",
  "formula",
  "prompt",
  "example",
  "steps",
  "answer_key",
  "meta",
] as const;

export type AllowedTeachingBlockType = (typeof ALLOWED_TEACHING_BLOCK_TYPES)[number];

const ALLOWED_SET = new Set<string>(ALLOWED_TEACHING_BLOCK_TYPES);

/** Unknown product types mapped onto the allowlist (e.g. fixture matrix-viz). */
const BLOCK_TYPE_ALIASES: Record<string, AllowedTeachingBlockType> = {
  "matrix-viz": "text",
  matrix_viz: "text",
  matrixviz: "text",
};

export type TeachingOutlineItem = {
  itemId: string;
  title: string;
  goalIds: string[];
  intendedBlockTypes: string[];
  sourceIds: string[];
  prereqItemIds?: string[];
  notes?: string;
};

export type TeachingPrerequisiteSuggestion = {
  itemId: string;
  reason: string;
  skippable: true;
  skipEffect: "continue_without" | "mark_skipped";
};

export type TeachingOutline = {
  outlineId: string;
  activityId: string;
  teachingUnitId?: string;
  focusItemId: string;
  items: TeachingOutlineItem[];
  prereqs: TeachingPrerequisiteSuggestion[];
  pathVersionHint?: number;
  /** Never calendar slots — teaching path only. */
  kind: "teaching_path";
};

export type HistoryFreezeDecision =
  | { action: "compile_current"; targetItemId: string }
  | {
      action: "revise_subsequent_only";
      frozenActivityIds: string[];
      reviseFromItemId: string;
    }
  | { action: "reject_rewrite_history"; reason: string };

/**
 * Drop/map unknown block types onto the M1 allowlist.
 * Never invents mastery fields.
 */
export function normalizeBlockTypes(types: string[]): string[] {
  const out: string[] = [];
  for (const raw of types) {
    if (typeof raw !== "string" || raw.length === 0) continue;
    const mapped = BLOCK_TYPE_ALIASES[raw] ?? raw;
    if (!ALLOWED_SET.has(mapped)) continue;
    if (!out.includes(mapped)) out.push(mapped);
  }
  return out.length > 0 ? out : ["text"];
}

/**
 * Throws if payload looks like DayPlanResult / PlannedBlock calendar shape.
 * Teaching path must stay orthogonal to planDay.
 */
export function assertTeachingPathNotPlanDay(value: unknown): void {
  if (value == null || typeof value !== "object") return;
  const v = value as Record<string, unknown>;

  if (v.kind === "plan_day" || v.kind === "day_plan" || v.kind === "calendar") {
    throw new Error("teaching path must not use planDay/calendar kind");
  }

  if (Array.isArray(v.blocks) && Array.isArray(v.unscheduledTaskIds)) {
    const first = v.blocks[0];
    if (
      first &&
      typeof first === "object" &&
      "taskId" in (first as object) &&
      "start" in (first as object) &&
      "end" in (first as object)
    ) {
      throw new Error(
        "teaching path must not be planDay DayPlanResult calendar shape",
      );
    }
  }

  if (
    "focusItemId" in v &&
    "items" in v &&
    v.kind !== undefined &&
    v.kind !== "teaching_path"
  ) {
    throw new Error(
      `teaching path kind must be "teaching_path", got ${String(v.kind)}`,
    );
  }
}

/**
 * Build explainable, always-skippable prerequisite suggestions from outline items.
 */
export function suggestPrerequisites(
  outline: TeachingOutline,
): TeachingPrerequisiteSuggestion[] {
  const byId = new Map(outline.items.map((item) => [item.itemId, item]));
  const seen = new Set<string>();
  const out: TeachingPrerequisiteSuggestion[] = [];

  for (const existing of outline.prereqs ?? []) {
    if (seen.has(existing.itemId)) continue;
    seen.add(existing.itemId);
    out.push({
      itemId: existing.itemId,
      reason:
        typeof existing.reason === "string" && existing.reason.trim().length > 0
          ? existing.reason
          : `Suggested before continuing past ${existing.itemId}`,
      skippable: true,
      skipEffect: existing.skipEffect === "mark_skipped" ? "mark_skipped" : "continue_without",
    });
  }

  for (const item of outline.items) {
    for (const prereqId of item.prereqItemIds ?? []) {
      if (seen.has(prereqId)) continue;
      seen.add(prereqId);
      const prereq = byId.get(prereqId);
      const title = prereq?.title ?? prereqId;
      out.push({
        itemId: prereqId,
        reason: `Helps with “${item.title}” — suggested after “${title}” (optional; you can skip).`,
        skippable: true,
        skipEffect: "continue_without",
      });
    }
  }

  return out;
}

/**
 * Freeze already-learned history; goal adjustments revise subsequent only.
 */
export function decideHistoryFreeze(input: {
  outline: TeachingOutline;
  publishedActivityIds: string[];
  learnedActivityIds: string[];
  goalAdjustment: boolean;
}): HistoryFreezeDecision {
  const learned = [...new Set(input.learnedActivityIds)];
  const focus = input.outline.focusItemId;
  const learnedSet = new Set(learned);

  // Focus targets an already-learned body → never rewrite that history.
  if (learnedSet.has(focus) || learnedSet.has(input.outline.activityId)) {
    if (input.goalAdjustment) {
      return {
        action: "revise_subsequent_only",
        frozenActivityIds: learned,
        reviseFromItemId: focus,
      };
    }
    return {
      action: "reject_rewrite_history",
      reason: "Cannot rewrite already-learned activity history",
    };
  }

  if (input.goalAdjustment && learned.length > 0) {
    return {
      action: "revise_subsequent_only",
      frozenActivityIds: learned,
      reviseFromItemId: focus,
    };
  }

  return { action: "compile_current", targetItemId: focus };
}

function assertRecordNoMastery(label: string, value: unknown): void {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return;
  try {
    assertNoMasteryPercentage(value as Record<string, unknown>);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}: ${message}`);
  }
}

/**
 * Honesty gates: kind, mastery ban, skippable prereqs, path ≠ planDay.
 */
export function assertOutlineHonest(outline: TeachingOutline): void {
  if (outline.kind !== "teaching_path") {
    throw new Error(`outline.kind must be "teaching_path", got ${String(outline.kind)}`);
  }
  assertTeachingPathNotPlanDay(outline);
  assertRecordNoMastery("outline", outline);

  if (!Array.isArray(outline.items) || outline.items.length === 0) {
    throw new Error("outline.items must be a non-empty array");
  }
  if (!outline.focusItemId) {
    throw new Error("outline.focusItemId is required");
  }
  const ids = new Set(outline.items.map((i) => i.itemId));
  if (!ids.has(outline.focusItemId)) {
    throw new Error(`outline.focusItemId ${outline.focusItemId} not in items`);
  }

  for (const item of outline.items) {
    assertRecordNoMastery(`outline.item:${item.itemId}`, item);
    item.intendedBlockTypes = normalizeBlockTypes(item.intendedBlockTypes ?? []);
  }

  for (const prereq of outline.prereqs ?? []) {
    assertRecordNoMastery(`outline.prereq:${prereq.itemId}`, prereq);
    if (prereq.skippable !== true) {
      throw new Error(`prerequisite ${prereq.itemId} must be skippable: true`);
    }
    if (typeof prereq.reason !== "string" || prereq.reason.trim().length === 0) {
      throw new Error(`prerequisite ${prereq.itemId} must include a human reason`);
    }
  }
}
