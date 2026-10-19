import "server-only";
import type { Scope } from "@aistudy/contracts";
import { createOpeningLearnerShadowPredictionsRepository } from "@aistudy/database";
import type { Sql } from "postgres";

/** Read-only application entry point; prediction capture belongs to canonical attempt start. */
export function createLearnerShadowComparisonService(sql: Sql) {
  const repository = createOpeningLearnerShadowPredictionsRepository(sql);
  return { read: (scope: Scope, input: { courseId?: string }) => repository.compare(scope, input) };
}
