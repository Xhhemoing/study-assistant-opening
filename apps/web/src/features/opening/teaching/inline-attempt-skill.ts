import { normalizeSkillLabelKey } from "../learning/skill-label-options";

/** An existing draft is the learner's choice; activity intentions are never skill identities. */
export function defaultInlineAttemptSkill(input: {
  draftSkillLabel?: string;
  questionSkillLabel?: string;
  learnerSkillLabel?: string;
  outlineTitle?: string;
  skillOptions?: readonly string[];
  knowledge?: { nodes: readonly { id: string; label: string; kind?: string }[] } | null;
}): string {
  if (input.draftSkillLabel !== undefined) return input.draftSkillLabel;
  const title = input.questionSkillLabel?.trim() || input.learnerSkillLabel?.trim() || input.outlineTitle?.trim();
  if (!title) return "课堂练习";
  const key = normalizeSkillLabelKey(title);
  const node = input.knowledge?.nodes.find(row => row.kind !== "chapter" && normalizeSkillLabelKey(row.label) === key);
  return (node?.label ?? input.skillOptions?.find(label => normalizeSkillLabelKey(label) === key) ?? title).slice(0, 200);
}
