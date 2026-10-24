import { createOpeningAiGradingService, type OpeningAiGradingServiceDeps } from "@aistudy/ai";
import { gradeObservationJobPayloadSchema } from "@aistudy/contracts";
import { openingJobScope, type OpeningJobRecord } from "@aistudy/database";

/** No browser signal: closing the page cannot cancel durable grading. The
 * execution scope fences pre-send and publication against cancellation/leases. */
export function createGradeObservationHandler(deps: OpeningAiGradingServiceDeps) {
  const service = createOpeningAiGradingService(deps);
  return async (job: OpeningJobRecord, raw: unknown) => {
    if (!job.claimToken || job.kind !== "grade-observation") throw Object.assign(new Error("批改任务缺少执行凭据"), { code: "CONFLICT" });
    const payload = gradeObservationJobPayloadSchema.parse(raw);
    const scope = openingJobScope(job);
    const context = await deps.repository.context(scope, { observationId: payload.observationId });
    if ((context.observation.rootObservationId ?? context.observation.id) !== payload.rootObservationId
      || context.answerRevision !== payload.answerRevision
      || job.key !== `ai-grade:${job.workspaceId}:${payload.rootObservationId}:${payload.answerRevision}`) {
      throw Object.assign(new Error("批改任务与封存作答不一致"), { code: "CONFLICT" });
    }
    const observation = await service.grade(scope, { observationId: payload.observationId });
    return { observationId: observation.id, rootObservationId: payload.rootObservationId, answerRevision: payload.answerRevision };
  };
}
