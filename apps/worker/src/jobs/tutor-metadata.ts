import { providerOutputSchema, tutorMetadataJobPayloadSchema, tutorModeSchema, type ProviderOutput, type Scope, type TutorMode } from "@aistudy/contracts";
import { buildTutorMetadataInput, canProposeTask, type ModelGatewayCallOptions } from "@aistudy/ai";
import type { OpeningJobRecord, OpeningTutorJobsRepository } from "@aistudy/database";

export type TutorMetadataDeps = {
  tutorJobs: Pick<OpeningTutorJobsRepository, "loadCompletedTurnForMetadata" | "canAppendCompletedTurnCandidates" | "appendCompletedTurnCandidates">;
  callModel(scope: Scope, mode: TutorMode, options: Omit<ModelGatewayCallOptions, "budget">): Promise<ProviderOutput>;
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
      beforeSend: async () => {
        if (!await deps.tutorJobs.canAppendCompletedTurnCandidates(target)) throw new Error("tutor metadata authorization changed");
      },
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
