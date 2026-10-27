import "server-only";
import { createOpeningLongTermPlanningRepository, readLearningCardSessions, writeLearningCardSession } from "@aistudy/database";
import type { Sql } from "postgres";
import { createLongTermPlanningService } from "./long-term-service";
import { isTeachingCompilerEnabled } from "@aistudy/ai";
export function getLongTermPlanningService(sql: Sql) {
  return createLongTermPlanningService(createOpeningLongTermPlanningRepository(sql, () => new Date(), { compilerEnabled: isTeachingCompilerEnabled(process.env) }), {
    read: (scope, id) => readLearningCardSessions(sql, scope, id), write: (scope, raw) => writeLearningCardSession(sql, scope, raw),
  });
}
