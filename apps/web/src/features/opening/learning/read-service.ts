import type { LearningObservation, LearningSummary, Scope } from "@aistudy/contracts";
import { summarizeObservations } from "@aistudy/domain";

export type OpeningLearningReadDeps = {
  assertOwnedCourse(scope: Scope, courseId: string): Promise<void>;
  listObservationsForCourse(scope: Scope, courseId: string): Promise<LearningObservation[]>;
  now?: () => string;
};

/**
 * Authenticated course summary. Empty observations stay [].
 * Unknown course and backend failures propagate; nothing is invented.
 */
export function createOpeningLearningReadService(deps: OpeningLearningReadDeps) {
  const now = deps.now ?? (() => new Date().toISOString());
  return {
    async summarizeLearning(scope: Scope, courseId: string): Promise<LearningSummary[]> {
      await deps.assertOwnedCourse(scope, courseId);
      const observations = await deps.listObservationsForCourse(scope, courseId);
      return summarizeObservations(observations, now());
    },
  };
}

export type OpeningLearningReadService = ReturnType<typeof createOpeningLearningReadService>;
