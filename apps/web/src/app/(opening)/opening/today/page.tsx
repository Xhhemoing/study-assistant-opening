import { redirect } from "next/navigation";
import { loadTodayPage } from "../../../../features/opening/planning/load-today-page";
import { TodayDashboard } from "../../../../features/opening/planning/today-dashboard";
import { isTeachingCompilerEnabled } from "@aistudy/ai";
import { assistantEntry } from "../../../../features/opening/assistant/assistant-entry";

export default async function OpeningTodayPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const task = typeof query.task === "string" ? query.task : typeof query.focusTask === "string" ? query.focusTask : undefined;
  if (task) redirect(`/opening/settings/planning?task=${encodeURIComponent(task)}`);
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) value.forEach(item => params.append(key, item));
    else if (value !== undefined) params.append(key, value);
  }
  const assistantHref = `/opening/assistant?${params}`;
  const entry = assistantEntry(assistantHref);
  // Legacy assistant links keep their context (including explicit parser errors),
  // but only the canonical assistant route mounts a conversation.
  if (entry.conversation || entry.context || entry.error || entry.fresh) redirect(assistantHref);
  const loaded = await loadTodayPage();
  return <TodayDashboard {...loaded} teachingCompileEnabled={isTeachingCompilerEnabled()} />;
}
