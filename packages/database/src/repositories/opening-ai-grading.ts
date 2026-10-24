import { aiGradingInputSchema, aiGradingMaterialProvenanceSchema, aiGradingProposalSchema, type AiGradingInput, type AiGradingMaterialProvenance, type AiGradingProposal, type LearningObservation, type Scope } from "@aistudy/contracts";
import { assertOpeningMaterialProvenance } from "./opening-material-assessment";
import type { Sql } from "postgres";
import { acceptedAiGradingOutcome } from "@aistudy/domain";
import { aiGradingClientKey, readOpeningAiGradingContext } from "./opening-ai-grading-context";
import { reviseOpeningLearningObservation } from "./opening-observation-revisions";
import { readOpeningAiGradingLedger, readOpeningAiGradingReleasedReservation } from "./opening-ai-grading-ledger";
export type { OpeningAiGradingContext } from "./opening-ai-grading-context";

/** Model I/O happens outside these short transactions; apply rechecks the current head and sources. */
export function createOpeningAiGradingRepository(sql: Sql) {
  const context = (scope: Scope, raw: AiGradingInput) => sql.begin(tx => readOpeningAiGradingContext(tx, scope, raw));
  return {
    context,
    ledger: (scope: Scope, operationId: string) => readOpeningAiGradingLedger(sql, scope, operationId),
    releasedReservation: (scope: Scope, input: Parameters<typeof readOpeningAiGradingReleasedReservation>[2]) =>
      readOpeningAiGradingReleasedReservation(sql, scope, input),
    async apply(scope: Scope, raw: AiGradingInput, rawProposal: AiGradingProposal, modelLabel: string | null,
      capturedProvenance?: AiGradingMaterialProvenance,
    ): Promise<LearningObservation> {
      const input = aiGradingInputSchema.parse(raw), parsed = aiGradingProposalSchema.parse(rawProposal);
      // Legacy trusted adapters may omit provenance, but never fill their historical
      // assessment from today's manifest: classified scores then qualify as unknown.
      const materialProvenance = capturedProvenance === undefined ? undefined : aiGradingMaterialProvenanceSchema.parse(capturedProvenance);
      const current = await context(scope, input);
      if (current.existing) return current.existing;
      if (materialProvenance) assertOpeningMaterialProvenance(materialProvenance, current.materialProvenance);
      // IDs are scoped to the immutable server-owned question, never invented by the model.
      const proposal: AiGradingProposal = { ...parsed, misconceptionId: acceptedAiGradingOutcome(parsed) === "incorrect"
        ? current.misconceptions.some(item => item.id === parsed.misconceptionId) ? parsed.misconceptionId : "other"
        : null };
      const original = current.observation;
      const result = await reviseOpeningLearningObservation(sql, scope, {
        rootObservationId: original.rootObservationId ?? original.id, revisesObservationId: original.id, expectedHead: original.id,
        revisionKind: "replace", reason: "AI 批改", clientKey: aiGradingClientKey(input),
        replacement: { answer: original.answer, outcome: acceptedAiGradingOutcome(proposal), assistance: original.assistance },
      }, { aiGrading: { input, proposal, modelLabel, ...(materialProvenance ? { materialProvenance } : {}) } });
      return result.observation!;
    },
  };
}
