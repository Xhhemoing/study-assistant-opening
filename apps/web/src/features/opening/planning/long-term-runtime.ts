import "server-only";
import { createOpeningLongTermPlanningRepository, readLearningCardSessions, writeLearningCardSession } from "@aistudy/database";
import type { Sql } from "postgres";
import { createLongTermPlanningService } from "./long-term-service";
import { isTeachingCompilerEnabled } from "@aistudy/ai";
export function getLongTermPlanningService(sql: Sql) {
  const compilerEnabled = isTeachingCompilerEnabled(process.env);
  return createLongTermPlanningService(createOpeningLongTermPlanningRepository(sql, () => new Date(), { compilerEnabled, exactVerificationEnabled: compilerEnabled }), {
    read: (scope, id) => readLearningCardSessions(sql, scope, id), write: (scope, raw) => writeLearningCardSession(sql, scope, raw),
  });
}
