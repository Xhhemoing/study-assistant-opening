import type { CourseRequirement } from "@aistudy/contracts";
import { buildDecisionInput, type CourseRouteObservation } from "@aistudy/domain";

/** Keep requirement/revision qualification and explicit-origin continuation.
 * Scope facts before canonical ordering; never manufacture a newer timestamp.
 */
export function courseRouteDecisionInput(requirement: CourseRequirement, observations: readonly CourseRouteObservation[], options: { dueRetest?: boolean; origin?: CourseRouteObservation } = {}) {
  let matching = observations.filter(row => row.usableForCurrentVersion === "yes" && (
    row.requirementKey === requirement.requirementKey && row.courseRequirement?.id === requirement.id
      && row.courseRequirement.revision === requirement.revision && row.courseRequirement.stableSkillId === requirement.stableSkillId
      && row.courseRequirement.requirementKey === requirement.requirementKey
    || row.sharedFor?.some(ref => ref.requirementId === requirement.id && ref.requirementRevision === requirement.revision
      && ref.stableSkillId === requirement.stableSkillId)));
  const origin = options.origin && matching.find(row => row.id === options.origin!.id);
  if (origin) matching = matching.filter(row => row.id === origin.id || Date.parse(row.attemptedAt) < Date.parse(origin.attemptedAt));
  // Preserve the existing rule: local errors/non-independent work cannot be
  // hidden by a cross-course success. Do not promote shared evidence here.
  const local = [...matching].filter(row => !row.sharedFor?.length)
    .sort((a, b) => Date.parse(b.attemptedAt) - Date.parse(a.attemptedAt) || b.id.localeCompare(a.id))[0];
  if (local && (local.verifiedCorrect !== "yes" || local.assistance !== "independent")) {
    matching = matching.filter(row => !row.sharedFor?.length);
  }
  const input = buildDecisionInput({ observations: matching, wantsFullExplanation: false, ...(options.dueRetest ? { dueRetest: true } : {}) });
  const latest = input.observations[0];
  // A current assisted success still needs reduced-help correction even when
  // earlier independent checks outnumber it (including interval-help retests).
  // Use the existing phase control without inventing or upgrading evidence.
  if (!options.dueRetest && latest?.verifiedCorrect === "yes" && (latest.assistance === "hinted" || latest.assistance === "revealed")) {
    return { ...input, learningPhase: "consolidate" as const, phaseSource: "automatic" as const };
  }
  return input;
}
