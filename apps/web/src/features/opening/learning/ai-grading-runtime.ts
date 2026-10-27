import "server-only";
import type { Sql } from "postgres";
import { createOpeningAiGradingJobRepository, readOpeningObservationGradingUsesVision } from "@aistudy/database";
import type { Scope } from "@aistudy/contracts";
import { resolveAutoGradePolicy } from "./auto-grade-policy";

/** HTTP can only enqueue/read. Paid execution is never tied to request lifetime. */
export function getAiGradingService(sql: Sql) {
  const repository = createOpeningAiGradingJobRepository(sql);
  return {
    ...repository,
    async read(scope: Scope, raw: unknown) {
      const status = await repository.read(scope, raw);
      if (status.jobId || !status.retryable) return status;
      const visualReference = await readOpeningObservationGradingUsesVision(sql, scope, status.headObservationId);
      const resolvedPolicy = await resolveAutoGradePolicy(sql, scope, Boolean(status.workSource) || visualReference === true);
      const policy = visualReference === null ? { ...resolvedPolicy, modelAvailable: false,
        modelUnavailableReason: "no_model" as const, primaryModel: null, fallbackModel: null } : resolvedPolicy;
      return repository.read(scope, raw, policy);
    },
  };
}
