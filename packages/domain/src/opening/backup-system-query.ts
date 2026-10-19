import { systemQueryReceiptSchema } from "@aistudy/contracts";
export function validateBackupSystemQuery(row: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (row.query_system !== undefined && typeof row.query_system !== "boolean") errors.push("turn query intent is invalid");
  if (row.system_query == null) return errors;
  const receipt = systemQueryReceiptSchema.safeParse(row.system_query);
  if (!receipt.success || row.query_system !== true || row.role !== "assistant"
    || receipt.data.authorization.workspaceId !== row.workspace_id) return [...errors, "turn query receipt is invalid"];
  const refs = Array.isArray(row.context_source_refs) ? row.context_source_refs : [];
  if (receipt.data.results.flatMap(result => result.sourceRefs).some(ref => !refs.some(item => item && typeof item === "object"
    && item.sourceId === ref.sourceId && item.sourceVersion === ref.sourceVersion))) errors.push("turn query receipt lineage is incomplete");
  return errors;
}
