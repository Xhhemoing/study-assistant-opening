import { summarizeObservations, type RetestEvidenceIdentity } from "../learning-summary";
import type { SkillStateEstimator } from "./types";

export type RulesSkillStateEstimatorOptions = {
  evaluatedAt: string;
  dueRetests?: readonly RetestEvidenceIdentity[];
};

/** rules-1 delegates qualification and latest-attempt semantics to their existing owner. */
export function createRulesSkillStateEstimator(options: RulesSkillStateEstimatorOptions): SkillStateEstimator {
  return {
    version: "rules-1",
    estimate(evidence) {
      if (!evidence.length) return { state: "unobserved", reasons: ["no_observations"] };
      const identities = new Set(evidence.map(row => JSON.stringify([
        row.record.workspaceId, row.courseId, row.requirementKey, row.skillLabel,
      ])));
      if (identities.size !== 1) throw new RangeError("Skill estimator requires one workspace, course, requirement, and skill group");
      const evidenceContexts = Object.fromEntries(evidence.flatMap(row => row.eligibilityInput
        ? [[row.observationId, row.eligibilityInput]] : []));
      const summaries = summarizeObservations(evidence.map(row => row.record), options.evaluatedAt, {
        evidenceContexts, dueRetests: options.dueRetests,
      });
      if (summaries.length !== 1) throw new RangeError("Skill evidence qualification does not match one summary group");
      const summary = summaries[0]!;
      const relevantIds = new Set(summary.recentPerformance?.evidenceIds ?? summary.evidenceIds);
      const reasons = new Set<string>(summary.evidenceEligibility.filter(row => relevantIds.has(row.observationId))
        .flatMap(row => row.eligibility.reasonCodes));
      if (summary.status === "needs_review") reasons.add("due_retest");
      return { state: summary.status, reasons: [...reasons].sort() };
    },
  };
}
