/**
 * Resolve a knowledge node id from course knowledge when the skill label matches.
 * Exact label match only — no fuzzy merge; SkillEvidence stays node-keyed.
 */
export function nodeIdForSkillLabel(
  snapshot:
    | { nodes: ReadonlyArray<{ id: string; label: string }> }
    | null
    | undefined,
  skillLabel: string,
): string | null {
  const needle = skillLabel.trim();
  if (!needle || !snapshot?.nodes?.length) return null;
  const match = snapshot.nodes.find((node) => node.label === needle);
  return match?.id ?? null;
}
