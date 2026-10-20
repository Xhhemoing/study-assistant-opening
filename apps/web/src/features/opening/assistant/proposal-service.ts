import "server-only";
import type { Sql } from "postgres";
import { isTeachingCompilerEnabled } from "@aistudy/ai";
import { createOpeningAssistantProposalsRepository } from "@aistudy/database";
import { assistantProposalCreateSchema, assistantProposalDecisionSchema, uuidSchema, type Scope } from "@aistudy/contracts";

export function createAssistantProposalService(sql: Sql) {
  const repository = createOpeningAssistantProposalsRepository(sql, { enqueueTeachingCompile: isTeachingCompilerEnabled() });
  return {
    list: (scope: Scope) => repository.list(scope),
    propose: (scope: Scope, raw: unknown) => repository.propose(scope, assistantProposalCreateSchema.parse(raw)),
    decide: (scope: Scope, id: unknown, raw: unknown) => repository.decide(scope, uuidSchema.parse(id), assistantProposalDecisionSchema.parse(raw)),
  };
}
