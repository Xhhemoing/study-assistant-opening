import { suggestionIdentity } from "./types";

/** Display aliases are normalized only within the same course and requirement. */
export function normalizeSkillLabelKey(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase().replace(/\s+/gu, "");
}

/** Missing attribution stays separate from every named requirement. */
export function adaptiveSkillIdentity(skillLabel: string, requirementKey?: string | null): string {
  return JSON.stringify([skillLabel, requirementKey ?? null]);
}

export function normalizedSuggestionIdentity(
  kind: string, courseId: string | null, skillLabel: string | null, requirementKey?: string | null,
): string {
  return suggestionIdentity(kind, courseId, skillLabel === null ? null : normalizeSkillLabelKey(skillLabel), requirementKey);
}

/** Recover comparison identity without changing a stored task's legacy clientKey. */
export function plannerHistoryIdentity(identity: string, skillLabel?: string | null, requirementKey?: string | null): string {
  if (!skillLabel) return identity;
  const parts = /^([^:]+):([^:]+):((?:requirement-)?[a-f0-9]{8})$/.exec(identity);
  // A scoped hash cannot be recovered safely when its stored requirement is missing.
  if (!parts || (parts[3]!.startsWith("requirement-") && requirementKey == null)) return identity;
  return normalizedSuggestionIdentity(parts[1]!, parts[2] === "none" ? null : parts[2]!, skillLabel, requirementKey);
}
