import "server-only";
import type { Sql } from "postgres";
import type { Scope } from "@aistudy/contracts";
import { recordOpeningLearningExperience } from "@aistudy/database";
export function submitOpeningLearningExperience(sql: Sql, scope: Scope, input: unknown) {
  return recordOpeningLearningExperience(sql, scope, input);
}
