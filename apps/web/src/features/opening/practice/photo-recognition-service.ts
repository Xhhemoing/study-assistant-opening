import { photoQuestionRecognitionInputSchema, type Scope } from "@aistudy/contracts";
import { createOpeningPhotoRecognitionRepository } from "@aistudy/database";
import type { Sql } from "postgres";

export function createPhotoRecognitionService(sql: Sql) {
  const repository = createOpeningPhotoRecognitionRepository(sql);
  return {
    read: (scope: Scope, raw: unknown) => repository.read(scope, photoQuestionRecognitionInputSchema.parse(raw)),
    start: (scope: Scope, raw: unknown) => repository.begin(scope, photoQuestionRecognitionInputSchema.parse(raw)),
  };
}
