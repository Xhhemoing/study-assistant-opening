import { isTeachingCompilerEnabled } from "@aistudy/ai";
import { TodayDashboard } from "@/features/opening/planning/today-dashboard";
import { loadTodayPage } from "@/features/opening/planning/load-today-page";

export default async function PlanningPage({ searchParams }: { searchParams: Promise<{ task?: string }> }) {
  const [{ task }, data] = await Promise.all([searchParams, loadTodayPage()]);
  return <TodayDashboard {...data} planning focusTaskId={task} teachingCompileEnabled={isTeachingCompilerEnabled()} />;
}
