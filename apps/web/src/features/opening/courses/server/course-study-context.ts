import "server-only";
import { loadFeatureSwitches, resolveCapabilities } from "@aistudy/config";
import { createOpeningCourseReadySourcesRepository } from "@aistudy/database";
import { DEFAULT_WORKSPACE_TIME_ZONE, resolveWorkspaceTimeZone } from "@aistudy/domain";
import { requireOpeningScope } from "../../runtime";
import { getPlanningSettingsService } from "../../server/data-services";

/** Ready materials and the teaching gate are read for the authenticated workspace. */
export async function loadCourseStudyContext(request: Request, courseId: string) {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const capabilities = resolveCapabilities(loadFeatureSwitches(), scope.ownerUserId);
    const [sources, settings] = await Promise.allSettled([
      createOpeningCourseReadySourcesRepository(sql).listReadySourceIdsForCourse(scope, courseId),
      getPlanningSettingsService(sql).get(scope),
    ]);
    return { sourceIds: sources.status === "fulfilled" ? sources.value : [], sourceLoadError: sources.status === "rejected",
      timeZone: settings.status === "fulfilled" ? resolveWorkspaceTimeZone(settings.value.settings?.timeZone) : DEFAULT_WORKSPACE_TIME_ZONE,
      teachingEnabled: capabilities.teachingLoop.api && capabilities.teachingLoop.ui,
      matrixInteractiveEnabled: capabilities.matrixTransformInteractive };
  } catch {
    return { sourceIds: [], sourceLoadError: true, timeZone: DEFAULT_WORKSPACE_TIME_ZONE, teachingEnabled: false, matrixInteractiveEnabled: false };
  }
}
