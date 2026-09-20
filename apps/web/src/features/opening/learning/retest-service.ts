import type { Scope } from "@aistudy/contracts";
import { createOpeningRetestRepository } from "@aistudy/database";
import type { Sql } from "postgres";

export function createOpeningRetestService(sql: Sql) {
  const repo = createOpeningRetestRepository(sql);
  return {
    accept(scope: Scope, id: string, clientKey: string) {
      return repo.accept(scope, id, clientKey);
    },
    saveCandidates(scope: Scope, candidates: Parameters<typeof repo.saveCandidates>[1]) {
      return repo.saveCandidates(scope, candidates);
    },
    listAcceptedSkillLabels(scope: Scope, courseId: string) {
      return repo.listAcceptedSkillLabels(scope, courseId);
    },
  };
}

export type OpeningRetestService = ReturnType<typeof createOpeningRetestService>;
