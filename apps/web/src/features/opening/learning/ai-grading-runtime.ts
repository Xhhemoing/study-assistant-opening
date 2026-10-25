import "server-only";
import type { Sql } from "postgres";
import { createOpeningAiGradingJobRepository } from "@aistudy/database";
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
      return repository.read(scope, raw, await resolveAutoGradePolicy(sql, scope, Boolean(status.workSource)));
    },
  };
}
