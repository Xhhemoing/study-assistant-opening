import type { AssistantCandidateRecord } from "@aistudy/contracts";
/** Never surface a different conversation's pending write suggestions. */
export function chatCandidateItems(rows: AssistantCandidateRecord[], turnIds: readonly string[]): AssistantCandidateRecord[] {
  const allowed = new Set(turnIds);
  return rows.filter(row => row.status === "pending" && allowed.has(row.sourceTurnId));
}
