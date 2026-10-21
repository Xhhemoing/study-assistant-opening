import { aiGradingInputSchema, aiGradingProposalSchema, type AiGradingInput, type AiGradingProposal, type LearningObservation, type Scope } from "@aistudy/contracts";
import type { Sql } from "postgres";
import { acceptedAiGradingOutcome } from "@aistudy/domain";
import { aiGradingClientKey, readOpeningAiGradingContext } from "./opening-ai-grading-context";
import { reviseOpeningLearningObservation } from "./opening-observation-revisions";
export type { OpeningAiGradingContext } from "./opening-ai-grading-context";

/** Model I/O happens outside these short transactions; apply rechecks the current head and sources. */
export function createOpeningAiGradingRepository(sql: Sql) {
  const context = (scope: Scope, raw: AiGradingInput) => sql.begin(tx => readOpeningAiGradingContext(tx, scope, raw));
  return {
    context,
    async apply(scope: Scope, raw: AiGradingInput, rawProposal: AiGradingProposal, modelLabel: string | null): Promise<LearningObservation> {
      const input = aiGradingInputSchema.parse(raw), proposal = aiGradingProposalSchema.parse(rawProposal);
      const current = await context(scope, input);
      if (current.existing) return current.existing;
      const original = current.observation;
      const result = await reviseOpeningLearningObservation(sql, scope, {
        rootObservationId: original.rootObservationId ?? original.id, revisesObservationId: original.id, expectedHead: original.id,
        revisionKind: "replace", reason: "AI 批改", clientKey: aiGradingClientKey(input),
        replacement: { answer: original.answer, outcome: acceptedAiGradingOutcome(proposal), assistance: original.assistance },
      }, { aiGrading: { input, proposal, modelLabel } });
      return result.observation!;
    },
  };
}
