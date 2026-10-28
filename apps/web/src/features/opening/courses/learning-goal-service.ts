import { learningGoalCreateSchema, learningGoalUpdateSchema, uuidSchema, type Scope } from "@aistudy/contracts";
import { createOpeningLearningGoalRepository } from "@aistudy/database";
import type { Sql } from "postgres";

export function createLearningGoalService(sql: Sql) {
  const repository = createOpeningLearningGoalRepository(sql);
  return {
    list: (scope: Scope, courseId?: string) => repository.list(scope, courseId ? uuidSchema.parse(courseId) : undefined),
    create: (scope: Scope, input: unknown) => repository.create(scope, learningGoalCreateSchema.parse(input)),
    update: (scope: Scope, id: string, input: unknown) => repository.update(scope, uuidSchema.parse(id), learningGoalUpdateSchema.parse(input)),
    select: (scope: Scope, input: unknown) => repository.select(scope, input),
  };
}
