import type { CourseRequirement } from "@aistudy/contracts";
import {
  classifyPlacementRoutes,
  DiagnosticPlacementError,
  KstStateSpace,
  type DiagnosticSkillNode,
  type KstSnapshotV1,
  type SkillPlacementRoute,
} from "../../diagnostic-placement";
import { normalizeSkillLabelKey } from "./skill-identity";
import type { SnapshotKnowledgeNode, SnapshotObservation } from "./snapshot-sources";

export type AdaptivePlacementInput = {
  knowledgeNodes?: readonly SnapshotKnowledgeNode[];
  /** Active requirements and evidence are scoped to a single course. */
  requirements?: readonly CourseRequirement[];
  observations: readonly SnapshotObservation[];
  /** Keyed by knowledge node id, or stable skill id for an unlinked requirement. */
  skillMetadataById?: ReadonlyMap<string, Pick<DiagnosticSkillNode, "chapterId" | "syllabusWeight">>;
};

export type AdaptivePlacement = {
  snapshot: KstSnapshotV1;
  placementRoutesByNodeId: ReadonlyMap<string, SkillPlacementRoute>;
  placementRoutesByRequirementId: ReadonlyMap<string, SkillPlacementRoute>;
};

export function toDiagnosticKnowledgeSkills(nodes: readonly SnapshotKnowledgeNode[]): DiagnosticSkillNode[] {
  const ids = new Set(nodes.map(node => node.id));
  return nodes.map(node => ({
    skillId: node.id,
    title: node.title,
    chapterId: "opening",
    prerequisiteIds: node.prerequisiteIds.filter(id => ids.has(id)),
  }));
}

// Effective Opening observations have no item calibration. Use the same nonzero
// guess/slip likelihood for each skill so even verified attempts stay probabilistic.
const SNAPSHOT_ATTEMPT_NOISE = 0.15;

export function buildAdaptivePlacement(input: AdaptivePlacementInput): AdaptivePlacement | null {
  const nodes = input.knowledgeNodes ?? [];
  const requirements = (input.requirements ?? []).filter(requirement => requirement.lifecycle === "active");
  const skills = new Map(toDiagnosticKnowledgeSkills(nodes).map(skill => [skill.skillId, skill]));
  const skillByRequirementId = new Map(requirements.map(requirement => [
    requirement.id,
    requirement.knowledgeNodeId && skills.has(requirement.knowledgeNodeId)
      ? requirement.knowledgeNodeId : requirement.stableSkillId,
  ]));
  const skillsByLabel = new Map<string, Set<string>>();
  const skillsByRequirementKey = new Map<string, Set<string>>();
  const link = (index: Map<string, Set<string>>, key: string, id: string) => {
    const ids = index.get(key) ?? new Set<string>();
    ids.add(id);
    index.set(key, ids);
  };
  for (const node of nodes) link(skillsByLabel, normalizeSkillLabelKey(node.title), node.id);
  for (const requirement of requirements) {
    const id = skillByRequirementId.get(requirement.id)!;
    const skill = skills.get(id) ?? { skillId: id, title: requirement.title, chapterId: requirement.courseId };
    const prerequisites = requirement.prerequisiteIds.flatMap(parent => {
      const parentId = skillByRequirementId.get(parent);
      // Two distinct requirements can intentionally share the same knowledge node.
      return parentId && (parentId !== id || parent === requirement.id) ? [parentId] : [];
    });
    skills.set(id, { ...skill, prerequisiteIds: [...new Set([...skill.prerequisiteIds ?? [], ...prerequisites])] });
    link(skillsByLabel, normalizeSkillLabelKey(requirement.title), id);
    link(skillsByRequirementKey, requirement.requirementKey, id);
  }
  if (!skills.size) return null;

  const graph = [...skills.values()].map(skill => ({ ...skill, ...input.skillMetadataById?.get(skill.skillId) }));
  let stateSpace: KstStateSpace;
  try {
    stateSpace = new KstStateSpace(graph);
  } catch (error) {
    if (error instanceof DiagnosticPlacementError && error.code === "VALIDATION"
      && /cycle|self-loop/i.test(error.message)) return null;
    throw error;
  }
  const evidence = new Map<string, { skillId: string; correct: boolean } | null>();
  for (const row of input.observations) {
    if (row.usableForCurrentVersion !== "yes" || row.assistance !== "independent" || row.independentAttempt !== "yes"
      || (row.verifiedCorrect !== "yes" && row.verifiedCorrect !== "no")) continue;
    const id = row.id.trim();
    const skillIds = row.requirementKey == null
      ? skillsByLabel.get(normalizeSkillLabelKey(row.skillLabel))
      : skillsByRequirementKey.get(row.requirementKey);
    if (!id || !skillIds || skillIds.size !== 1) continue;
    const [skillId] = skillIds;
    const correct = row.verifiedCorrect === "yes";
    const previous = evidence.get(id);
    if (!skillId || previous === null) continue;
    evidence.set(id, previous && (previous.skillId !== skillId || previous.correct !== correct) ? null : { skillId, correct });
  }
  for (const id of [...evidence.keys()].sort()) {
    const attempt = evidence.get(id);
    if (!attempt) continue;
    stateSpace.applyProbeObservation({
      itemId: id, familyId: id, chapterId: stateSpace.graph.skillsById.get(attempt.skillId)!.chapterId,
      requiredSkillIds: [attempt.skillId], slip: SNAPSHOT_ATTEMPT_NOISE, guess: SNAPSHOT_ATTEMPT_NOISE, estimatedSeconds: 1,
    }, { observationId: id, itemId: id, correct: attempt.correct, channel: "unassisted" });
  }

  const snapshot = stateSpace.buildPriorSnapshot({ createdAtMs: 0 });
  const routes = new Map(classifyPlacementRoutes(snapshot, graph).map(route => [route.skillId, route]));
  return {
    snapshot,
    placementRoutesByNodeId: new Map(nodes.map(node => [node.id, routes.get(node.id)!])),
    placementRoutesByRequirementId: new Map([...skillByRequirementId].map(([id, skillId]) => [id, routes.get(skillId)!])),
  };
}
