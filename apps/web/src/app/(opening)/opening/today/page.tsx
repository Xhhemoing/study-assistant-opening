import { redirect } from "next/navigation";
import { loadTodayPage } from "../../../../features/opening/planning/load-today-page";
import { TodayDashboard } from "../../../../features/opening/planning/today-dashboard";
import { hasNoTodayCourses } from "../../../../features/opening/planning/today-read";
import { isTeachingCompilerEnabled } from "@aistudy/ai";
import { StartPage } from "../../../../features/opening/start/start-page";
import { AssistantSession } from "../../../../features/opening/assistant/assistant-session";
import { assistantEntry } from "../../../../features/opening/assistant/assistant-entry";

export default async function OpeningTodayPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const task = typeof query.task === "string" ? query.task : typeof query.focusTask === "string" ? query.focusTask : undefined;
  if (task) redirect(`/opening/settings/planning?task=${encodeURIComponent(task)}`);
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (typeof value === "string") params.set(key, value);
  const entry = assistantEntry(`/opening/assistant?${params}`);
  if (entry.conversation || entry.context || entry.error) return <AssistantSession entry={entry} embedded={false} />;
  const loaded = await loadTodayPage();
  if (hasNoTodayCourses(loaded.state)) return <StartPage {...loaded} />;
  return <TodayDashboard {...loaded} teachingCompileEnabled={isTeachingCompilerEnabled()} />;
}
