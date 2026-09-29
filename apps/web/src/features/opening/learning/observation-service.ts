import { learningSessionCreateInputSchema, observationInputSchema, observationRevisionInputSchema, uuidSchema, type Scope } from "@aistudy/contracts";
import type { OpeningLearningRepository } from "@aistudy/database";

export function createOpeningObservationService(repo: OpeningLearningRepository) {
  return {
    reviseObservation(scope: Scope, raw: unknown) { return repo.reviseObservation(scope, observationRevisionInputSchema.parse(raw)); },
    observationHistory(scope: Scope, id: string) { return repo.observationHistory(scope, uuidSchema.parse(id)); },
    createLearningSession(scope: Scope, raw: unknown) { return repo.createSession(scope, learningSessionCreateInputSchema.parse(raw)); },
    submitObservation(scope: Scope, raw: unknown) { return repo.insertObservation(scope, observationInputSchema.parse(raw)); },
  };
}
export type OpeningObservationService = ReturnType<typeof createOpeningObservationService>;
