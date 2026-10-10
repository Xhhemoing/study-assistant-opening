import type { OrganizationResult } from "./material-organization-client";
import { createSourceActionsClient, SourceActionsError, type SourceActionsClient } from "../inbox/source-actions-client";

/** Sequentially impact+delete each id; surfaces succeeded/failed like membership batch. */
export async function deleteSelectedMaterials(
  sourceIds: readonly string[],
  api: SourceActionsClient = createSourceActionsClient(),
): Promise<OrganizationResult> {
  const succeeded: string[] = [];
  const failed: Array<{ id: string; message: string }> = [];
  for (const id of [...new Set(sourceIds)]) {
    try {
      const impact = await api.impact(id);
      await api.act(id, {
        action: "delete",
        expectedVersion: impact.version,
        expectedMembershipIds: impact.courses.map((course) => course.membershipId),
      });
      succeeded.push(id);
    } catch (reason) {
      const message = reason instanceof SourceActionsError || reason instanceof Error
        ? reason.message
        : "删除暂时未完成，请重试。";
      failed.push({ id, message });
    }
  }
  return { succeeded, failed };
}
