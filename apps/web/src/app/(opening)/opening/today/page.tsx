import { headers } from "next/headers";
import { DEFAULT_WORKSPACE_TIME_ZONE, resolveWorkspaceTimeZone } from "@aistudy/domain";
import { ApiError } from "../../../../features/auth/service";
import type { TodayResumeState } from "../../../../features/opening/planning/today-read";
import { createTodayResumeReader, loadTodayResumeState } from "../../../../features/opening/planning/today-service";
import { TodayDashboard } from "../../../../features/opening/planning/today-dashboard";
import { requireOpeningScope } from "../../../../features/opening/runtime";
import { getPlanningSettingsService } from "../../../../features/opening/server/data-services";
import { isTeachingCompilerEnabled } from "@aistudy/ai";


export default async function OpeningTodayPage({ searchParams }: { searchParams: Promise<{ task?: string }> }) {
  const { state, timeZone } = await loadPage(), { task } = await searchParams;
  return <TodayDashboard state={state} focusTaskId={task} timeZone={timeZone} teachingCompileEnabled={isTeachingCompilerEnabled()} />;
}
async function loadPage(): Promise<{ state: TodayResumeState; timeZone: string }> {
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
