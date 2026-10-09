/** Collapse whitespace / full-width / case so near-duplicate skill names can be hinted. */
export function normalizeSkillLabelKey(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase().replace(/\s+/gu, "");
}

/** Unique skill labels from learning summary rows, preserving first-seen spelling. */
export function collectSkillLabelOptions(
  rows: ReadonlyArray<{ skillLabel?: string | null } | { identity?: { skillLabel?: string | null } }>,
): string[] {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const row of rows) {
    const label =
      "identity" in row && row.identity
        ? row.identity.skillLabel?.trim()
        : "skillLabel" in row
          ? row.skillLabel?.trim()
          : undefined;
    if (!label) continue;
    const key = normalizeSkillLabelKey(label);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    labels.push(label);
  }
  return labels.sort((a, b) => a.localeCompare(b, "zh-CN"));
}

/**
 * When the typed label differs only by space / full-halfwidth / case from an existing
 * course skill, suggest reusing that exact name. Never auto-rewrites the input.
 */
export function findSkillLabelReuseHint(input: string, options: ReadonlyArray<string>): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const key = normalizeSkillLabelKey(trimmed);
  if (!key) return null;
  for (const option of options) {
    if (option === trimmed) return null;
    if (normalizeSkillLabelKey(option) === key) return option;
  }
  return null;
}
