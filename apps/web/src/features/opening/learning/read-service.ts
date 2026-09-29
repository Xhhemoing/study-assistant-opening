import type { LearningObservation, LearningSummary, Scope } from "@aistudy/contracts";
import { summarizeObservations, type CourseEvidence } from "@aistudy/domain";

export type OpeningLearningReadDeps = {
  assertOwnedCourse(scope: Scope, courseId: string): Promise<void>;
  readCourseEvidence(scope: Scope, courseId: string): Promise<CourseEvidence>;
  readCourseObservationHeads(scope: Scope, courseId: string): Promise<LearningObservation[]>;
  now?: () => string;
};

/** Course authorization precedes the shared server evidence read. */
export function createOpeningLearningReadService(deps: OpeningLearningReadDeps) {
  const now = deps.now ?? (() => new Date().toISOString());
  return {
    async listLearningObservations(scope: Scope, courseId: string): Promise<LearningObservation[]> {
      await deps.assertOwnedCourse(scope, courseId);
      return deps.readCourseObservationHeads(scope, courseId);
    },
    async summarizeLearning(scope: Scope, courseId: string): Promise<LearningSummary[]> {
      await deps.assertOwnedCourse(scope, courseId);
      const { observations, evidenceContexts } = await deps.readCourseEvidence(scope, courseId);
      return summarizeObservations(observations, now(), { evidenceContexts });
    },
  };
}

export type OpeningLearningReadService = ReturnType<typeof createOpeningLearningReadService>;
