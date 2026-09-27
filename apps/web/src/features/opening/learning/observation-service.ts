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
      const session = await repo.getSession(scope, input.sessionId);
      if (!session) {
        throw Object.assign(new Error("session not found"), { code: "NOT_FOUND" });
      }
      const verdictSource = input.verdictSource ?? "self_report";
      if (verdictSource === "unknown" && input.outcome === "correct") {
        throw Object.assign(new Error("unknown verdict cannot be formally correct"), {
          code: "VALIDATION",
        });
      }
      if (verdictSource === "reference_checked" && (
        !input.referenceSourceId || !session.sourceIds.includes(input.referenceSourceId)
      )) {
        throw Object.assign(new Error("reference source is not bound to this session"), {
          code: "VALIDATION",
        });
      }
      if (input.revisesObservationId) {
        throw Object.assign(
          new Error("observation revision requires a revision column or table; migration not applied"),
          { code: "CONFLICT" },
        );
      }
      return repo.insertObservation(scope, input, {
        verdictSource,
        referenceSourceId: input.referenceSourceId ?? null,
      });
    },
  };
}

export type OpeningObservationService = ReturnType<
  typeof createOpeningObservationService
>;
