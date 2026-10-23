import { teachingHintRequestSchema, type Scope } from "@aistudy/contracts";
import { createOpeningTeachingHintRepository } from "@aistudy/database";
import type { Sql } from "postgres";

export function createTeachingHintService(sql: Sql) {
  const repository = createOpeningTeachingHintRepository(sql);
  return {
    read(scope: Scope, raw: unknown) { return repository.read(scope, teachingHintRequestSchema.parse(raw)); },
    readReleased(scope: Scope, raw: unknown) { return repository.readReleased(scope, teachingHintRequestSchema.pick({ attemptId: true }).strict().parse(raw)); },
  };
}
