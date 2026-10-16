import { suggestionIdentity } from "./types";

/** Shared comparison key; display labels and persisted suggestion keys stay intact. */
export function normalizeSkillLabelKey(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase().replace(/\s+/gu, "");
}

export function normalizedSuggestionIdentity(kind: string, courseId: string | null, skillLabel: string | null): string {
  return suggestionIdentity(kind, courseId, skillLabel === null ? null : normalizeSkillLabelKey(skillLabel));
}

/** Recover comparison identity from a stored task without changing its legacy clientKey. */
export function plannerHistoryIdentity(identity: string, skillLabel?: string | null): string {
  if (!skillLabel) return identity;
  const parts = /^([^:]+):([^:]+):[a-f0-9]{8}$/.exec(identity);
  if (!parts) return identity;
  return normalizedSuggestionIdentity(parts[1]!, parts[2] === "none" ? null : parts[2]!, skillLabel);
}
