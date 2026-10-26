import { isTeachingCompilerEnabled } from "@aistudy/ai";
import { SettingsView } from "@/features/settings/settings-view";
import { TodayDashboard } from "@/features/opening/planning/today-dashboard";
import { loadTodayPage } from "@/features/opening/planning/load-today-page";

export default async function LearningSettingsPage({ searchParams }: { searchParams: Promise<{ task?: string; planning?: string }> }) {
  const { task, planning } = await searchParams;
  const dashboard = planning === "1" || task ? <TodayDashboard {...await loadTodayPage()} planning focusTaskId={task} teachingCompileEnabled={isTeachingCompilerEnabled()} /> : undefined;
  return <SettingsView basePath="/opening/settings" section="learning" planning={dashboard} />;
}
