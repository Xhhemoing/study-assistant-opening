import "server-only";
import { uuidSchema } from "@aistudy/contracts";
import { loadFeatureSwitches, resolveCapabilities } from "@aistudy/config";
import { resolveOpeningStudyContext } from "@aistudy/database";
import { requireOpeningScope, getTeachingActivityService, getTeachingContentService } from "../../runtime";

/** Read a saved, pinned handout; never restore a session or schedule compilation. */
export async function loadCourseHandout(request: Request, courseId: string, activityId: string) {
  if (!uuidSchema.safeParse(courseId).success || !uuidSchema.safeParse(activityId).success) return null;
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const capabilities = resolveCapabilities(loadFeatureSwitches(), scope.ownerUserId);
    if (!capabilities.teachingLoop.api || !capabilities.teachingLoop.ui) return null;
    const activity = await getTeachingActivityService(sql).get(scope, activityId);
    if (activity.courseId !== courseId || activity.contentVersion <= 0 ||
        (activity.generateStatus !== "ready" && activity.generateStatus !== "needs_check")) return null;
    // Association-only permits archived courses without enabling learning commands.
    await resolveOpeningStudyContext(sql, scope, { purpose: "material_read", courseId, activityId }, { associationOnly: true, sourceAccess: "human_read" });
    const init = await getTeachingContentService(sql).getClientInit(scope, activityId);
    if (init.activityId !== activity.id || init.contentVersion !== activity.contentVersion || init.version !== activity.contentVersion) return null;
    for (const ref of init.sourceRefs) {
      const version = ref.version == null ? NaN : Number(ref.version);
      if (!Number.isSafeInteger(version) || version < 0) return null;
      await resolveOpeningStudyContext(sql, scope, { purpose: "material_read", sourceId: ref.sourceId,
        sourceVersion: version, chunkId: ref.chunkId, page: ref.page }, { sourceAccess: "human_read" });
    }
    return { courseId, init, generateStatus: activity.generateStatus };
  } catch {
    // Identity, stale pins and unavailable material share the same public result.
    return null;
  }
}
