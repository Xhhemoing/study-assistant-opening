import type { GoalLearningContext, KnowledgeSnapshot, TeachingLearnerFocus } from "@aistudy/contracts";
import type { SnapshotKnowledgeNode, SnapshotObservation } from "./snapshot-sources";
import { normalizeSkillLabelKey } from "./skill-identity";

/** Suggested or stale structure must not become a mandatory learning dependency. */
export function toSupportedKnowledgeNodes(snapshot: KnowledgeSnapshot): SnapshotKnowledgeNode[] {
  const nodes = snapshot.nodes.filter(node => node.kind !== "chapter" && node.status === "supported");
  const ids = new Set(nodes.map(node => node.id));
  return nodes.map(node => ({ id: node.id, title: node.label,
    prerequisiteIds: [...new Set(snapshot.edges.filter(edge => edge.kind === "prerequisite"
      && edge.status === "supported" && edge.to === node.id && edge.from !== node.id && ids.has(edge.from))
      .map(edge => edge.from))],
  }));
}

type PrerequisiteRepair = NonNullable<TeachingLearnerFocus["prerequisiteRepair"]>;
// Conservative scheduling policy, not an estimate of how quickly a skill decays.
const RECENT_PREREQUISITE_EVIDENCE_MS = 30 * 86_400_000;

/**
 * One bounded prelude for a known direct prerequisite, never a mastery propagation.
 * Current evidence still uses labels: ambiguity in nodes or requirements means no
 * automatic detour. Missing evidence is unknown, not a reason to reteach ancestors.
 */
export function selectPrerequisiteRepair(input: {
  targetSkillLabel: string;
  knowledgeNodes: readonly SnapshotKnowledgeNode[];
  observations: readonly SnapshotObservation[];
  goalContext: GoalLearningContext;
  now: Date;
}): PrerequisiteRepair | null {
  const key = normalizeSkillLabelKey(input.targetSkillLabel);
  const targets = input.knowledgeNodes.filter(node => normalizeSkillLabelKey(node.title) === key);
  if (targets.length !== 1) return null;
  const target = targets[0]!;
  const now = input.now.getTime();
  const candidates = input.knowledgeNodes.flatMap(node => {
    if (!target.prerequisiteIds.includes(node.id) || node.id === target.id || node.title.length > 200) return [];
    const nodeKey = normalizeSkillLabelKey(node.title);
    if (input.knowledgeNodes.filter(other => normalizeSkillLabelKey(other.title) === nodeKey).length !== 1) return [];
    const observations = input.observations.filter(row => normalizeSkillLabelKey(row.skillLabel) === nodeKey
      && row.usableForCurrentVersion === "yes")
      .sort((a, b) => Date.parse(b.attemptedAt) - Date.parse(a.attemptedAt) || a.id.localeCompare(b.id));
    // Requirement identity is not yet attached to graph nodes; do not guess which
    // requirement a prerequisite edge denotes when several are present.
    if (new Set(observations.map(row => row.requirementKey ?? null)).size !== 1) return [];
    const latest = observations[0];
    if (!latest) return [];
    const age = now - Date.parse(latest.attemptedAt);
    if (!Number.isFinite(age) || age < 0 || age > RECENT_PREREQUISITE_EVIDENCE_MS) return [];
    const incorrect = latest.verifiedCorrect === "no";
    const assisted = latest.verifiedCorrect === "yes" && latest.independentAttempt === "no"
      && (latest.assistance === "hinted" || latest.assistance === "revealed");
    if (!incorrect && !assisted) return [];
    return [{ node, latest, incorrect }];
  }).sort((a, b) => Number(b.incorrect) - Number(a.incorrect)
    || Date.parse(b.latest.attemptedAt) - Date.parse(a.latest.attemptedAt) || a.node.id.localeCompare(b.node.id));
  const selected = candidates[0];
  if (!selected) return null;
  return {
    nodeId: selected.node.id, targetNodeId: target.id,
    skillLabel: selected.node.title, returnToSkillLabel: input.targetSkillLabel,
    maxMinutes: input.goalContext.prerequisiteBudgetMinutes,
    reason: `当前图谱将「${selected.node.title}」列为「${input.targetSkillLabel}」的直接前置，最近有效作答${selected.incorrect ? "有明确错误" : "仍依赖提示"}。`,
    stopCondition: `能说清并自行完成「${selected.node.title}」用于原题的关键一步后，立即回到「${input.targetSkillLabel}」；达到时间预算也回到原目标，未解决处保留为后续需求。`,
  };
}
