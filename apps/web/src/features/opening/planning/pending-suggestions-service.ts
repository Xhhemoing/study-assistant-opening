import "server-only";
import { createOpeningAssistantProposalsRepository, readOpeningAssistantReviewCandidates, readOpeningRetestReviewCandidates } from "@aistudy/database";
import type { Scope } from "@aistudy/contracts";
import type { Sql } from "postgres";

/** The Today summary and reviews badge share these currently visible proposals. */
export async function countPendingSuggestions(sql: Sql, scope: Scope): Promise<number> {
  const [assistant, retests, drafts] = await Promise.all([
    readOpeningAssistantReviewCandidates(sql, scope),
    readOpeningRetestReviewCandidates(sql, scope),
    createOpeningAssistantProposalsRepository(sql).countPending(scope),
  ]);
  return assistant.filter(candidate => candidate.workspaceId === scope.workspaceId && candidate.status === "pending").length
    + retests.length + drafts;
}
