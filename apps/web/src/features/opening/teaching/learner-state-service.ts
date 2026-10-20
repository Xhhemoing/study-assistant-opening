import "server-only";
import type { Scope } from "@aistudy/contracts";
import { createOpeningLearnerStateService } from "@aistudy/database";
import type { Sql } from "postgres";

/** Read-only application boundary; canonical attempts own learning mutations. */
export function createLearnerStateReadService(sql: Sql) {
  const state = createOpeningLearnerStateService(sql);
  return { read: (scope: Scope, input: { courseId?: string; limit?: number }) => state.read(scope, input) };
}
