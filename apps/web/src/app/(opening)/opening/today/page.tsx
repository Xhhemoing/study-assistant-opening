import { redirect } from "next/navigation";
import { isTeachingCompilerEnabled } from "@aistudy/ai";
import { TodayDashboard } from "../../../../features/opening/planning/today-dashboard";
import { loadTodayPage } from "../../../../features/opening/planning/load-today-page";

export default async function OpeningTodayPage({ searchParams }: { searchParams: Promise<{ task?: string }> }) {
  const { task } = await searchParams;
  if (task) redirect(`/opening/settings/planning?task=${encodeURIComponent(task)}`);
  return <TodayDashboard {...await loadTodayPage()} teachingCompileEnabled={isTeachingCompilerEnabled()} />;
}
