import { headers } from "next/headers";
import { ApiError } from "../../../../features/auth/service";
import type { TodayResumeState } from "../../../../features/opening/planning/today-read";
import { createTodayResumeReader, loadTodayResumeState } from "../../../../features/opening/planning/today-service";
import { TodayDashboard } from "../../../../features/opening/planning/today-dashboard";
import { requireOpeningScope } from "../../../../features/opening/runtime";


export default async function OpeningTodayPage({ searchParams }: { searchParams: Promise<{ task?: string }> }) {
  const state = await loadPage(), { task } = await searchParams;
  return <TodayDashboard state={state} focusTaskId={task} />;
}
async function loadPage(): Promise<TodayResumeState> {
  try {
    const request = new Request("http://opening.local/today", { headers: await headers() });
    const { scope, sql } = await requireOpeningScope(request);
    return await loadTodayResumeState({ scope, reader: createTodayResumeReader(sql) });
  } catch (error) {
    return { kind: error instanceof ApiError && error.status === 401 ? "loggedOut" : "error" };
  }
}
