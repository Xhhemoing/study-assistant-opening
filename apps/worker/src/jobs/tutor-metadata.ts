import { providerOutputSchema, tutorMetadataJobPayloadSchema, tutorModeSchema, type ProviderOutput, type Scope, type TutorMode } from "@aistudy/contracts";
import {
  buildTutorMetadataInput, canProposeTask, modelTaskSpec, OpeningModelRoutingError, reservationTerms,
  runBudgetedCall, tutorModelTask, withModelFallback, type BudgetedCallOptions, type BudgetedRepository,
  type ModelGateway, type ModelGatewayCallOptions,
} from "@aistudy/ai";
import type { OpeningJobRecord, OpeningTutorJobsRepository } from "@aistudy/database";

type TutorMetadataCallOptions = Pick<ModelGatewayCallOptions,
  "input" | "operationId" | "parentBudget" | "resultRef" | "persistResult">
  & Pick<BudgetedCallOptions, "authorizeAndStartSend">;

/** Metadata needs the budgeted call's atomic provider start after model selection. */
export function callTutorMetadataModel(
  gateway: Pick<ModelGateway, "resolve" | "resolveFallback">, scope: Scope, mode: TutorMode,
  options: TutorMetadataCallOptions, budget: BudgetedRepository,
): Promise<ProviderOutput> {
  const task = tutorModelTask(mode);
  return withModelFallback({
    primary: () => gateway.resolve(scope, task),
    fallback: () => gateway.resolveFallback(scope, task),
    operationId: options.operationId,
    run: (model, operationId) => {
      const terms = reservationTerms(model, options.input);
      if (!Number.isSafeInteger(terms.reservedCents) || terms.reservedCents < 0) {
        throw new OpeningModelRoutingError("模型费用无法安全估算，请检查价格或选择备用模型。");
      }
      return runBudgetedCall({
        ...options,
        ...terms,
        provider: model.provider,
        modelSnapshot: model.modelSnapshot,
        budget,
        requestId: operationId,
        operationId,
        requestFamily: options.operationId,
        purpose: modelTaskSpec(task).purpose,
        parentBudget: options.parentBudget ?? { id: options.operationId },
      });
    },
  });
}

export type TutorMetadataDeps = {
  tutorJobs: Pick<OpeningTutorJobsRepository, "loadCompletedTurnForMetadata" | "authorizeMetadataSend" | "appendCompletedTurnCandidates">;
  callModel(scope: Scope, mode: TutorMode, options: TutorMetadataCallOptions): Promise<ProviderOutput>;
};

/** Optional suggestions own a separate job, worker slot, and budget operation. */
export function createTutorMetadataHandler(deps: TutorMetadataDeps) {
  return async (job: OpeningJobRecord, payload: unknown) => {
    const body = tutorMetadataJobPayloadSchema.parse(payload);
    const scope = { workspaceId: job.workspaceId, ownerUserId: job.ownerUserId };
    const target = { scope, jobId: body.tutorJobId, assistantTurnId: body.assistantTurnId,
      claimToken: body.tutorClaimToken ?? undefined, expectedPrivacyEpoch: job.privacyEpoch,
      metadataLease: { id: job.id, claimToken: job.claimToken } };
    const completed = await deps.tutorJobs.loadCompletedTurnForMetadata(target);
    if (!completed) return { skipped: true };
    const mode = tutorModeSchema.parse(completed.mode);
    const input = buildTutorMetadataInput({ instruction: "", text: completed.question, mode,
      chunks: [], history: [], maxOutputTokens: 700, imageParts: [], mediaCapability: "text_only" }, completed.answer);
    let appended = false;
    await deps.callModel(scope, mode, {
      input, operationId: `tutor:${body.tutorJobId}:metadata`,
      parentBudget: { id: `study-turn:${completed.userTurnId}` },
      resultRef: `opening_turn_candidates:${body.assistantTurnId}`,
      authorizeAndStartSend: startSend => deps.tutorJobs.authorizeMetadataSend(target, startSend),
      persistResult: async output => {
        const { candidates } = providerOutputSchema.parse(output);
        appended = await deps.tutorJobs.appendCompletedTurnCandidates({ ...target,
          candidates: canProposeTask(mode) ? candidates : candidates.filter(candidate => candidate.kind !== "task"),
        });
      },
    });
    return { skipped: false, appended };
  };
}
