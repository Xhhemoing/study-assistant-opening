/** Display aliases are normalized only within the same course and requirement. */
export function normalizeSkillLabelKey(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase().replace(/\s+/gu, "");
}

/** Missing attribution stays separate from every named requirement. */
export function adaptiveSkillIdentity(skillLabel: string, requirementKey?: string | null): string {
  return JSON.stringify([skillLabel, requirementKey ?? null]);
}
