import {
  learningSessionCreateInputSchema,
  observationInputSchema,
  type LearningObservation,
  type LearningSessionCreateInput,
  type ObservationInput,
  type Scope,
} from "@aistudy/contracts";
import type { OpeningLearningRepository } from "@aistudy/database";

/**
 * L01 observation service — validates contracts then delegates to repository.
 * Wire repository via opening runtime (same pattern as sources/jobs).
 */
export function createOpeningObservationService(repo: OpeningLearningRepository) {
  return {
    async createLearningSession(
      scope: Scope,
      raw: unknown,
    ): Promise<{ id: string }> {
      const input: LearningSessionCreateInput =
        learningSessionCreateInputSchema.parse(raw);
      return repo.createSession(scope, input);
    },

    async submitObservation(
      scope: Scope,
      raw: unknown,
    ): Promise<LearningObservation & { allowsIndependent: boolean }> {
      const input: ObservationInput = observationInputSchema.parse(raw);
      return repo.insertObservation(scope, input, {
        verdictSource: "self_report",
      });
    },
  };
}

export type OpeningObservationService = ReturnType<
  typeof createOpeningObservationService
>;
