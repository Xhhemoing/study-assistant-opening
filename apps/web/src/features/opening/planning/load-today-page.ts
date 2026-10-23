import { headers } from "next/headers";
import { DEFAULT_WORKSPACE_TIME_ZONE, resolveWorkspaceTimeZone } from "@aistudy/domain";
import { ApiError } from "../../auth/service";
import type { TodayResumeState } from "./today-read";
import { createTodayResumeReader, loadTodayResumeState } from "./today-service";
import { requireOpeningScope } from "../runtime";
import { getPlanningSettingsService } from "../server/data-services";


export async function loadTodayPage(): Promise<{ state: TodayResumeState; timeZone: string }> {
  try {
    const request = new Request("http://opening.local/today", { headers: await headers() });
    const { scope, sql } = await requireOpeningScope(request);
    // Workspace business zone (planning_settings.timeZone, default Asia/Shanghai);
    // the client must not derive "today" from the browser zone.
    const [state, preference] = await Promise.all([
      loadTodayResumeState({ scope, reader: createTodayResumeReader(sql) }),
      getPlanningSettingsService(sql).get(scope),
    ]);
    return { state, timeZone: resolveWorkspaceTimeZone(preference.settings?.timeZone) };
  } catch (error) {
    return {
      state: { kind: error instanceof ApiError && error.status === 401 ? "loggedOut" : "error" },
      timeZone: DEFAULT_WORKSPACE_TIME_ZONE,
    };
  }
}
