import { createOpeningLearningAssetLinkRepository, createOpeningStudyNoteRepository } from "@aistudy/database";
import { learningAssetIdentitySchema, learningAssetLinkCreateSchema, learningAssetLinkDetachSchema, studyNoteCreateSchema, type Scope } from "@aistudy/contracts";
import type { Sql } from "postgres";
export function createLearningAssetLinkService(sql: Sql) {
  const links = createOpeningLearningAssetLinkRepository(sql), notes = createOpeningStudyNoteRepository(sql);
  return {
    list: (scope: Scope, input: unknown) => links.list(scope, learningAssetIdentitySchema.parse(input)),
    create: (scope: Scope, input: unknown) => links.create(scope, learningAssetLinkCreateSchema.parse(input)),
    detach: (scope: Scope, input: unknown) => links.detach(scope, learningAssetLinkDetachSchema.parse(input)),
    note: (scope: Scope, input: unknown) => notes.create(scope, studyNoteCreateSchema.parse(input)),
  };
}
