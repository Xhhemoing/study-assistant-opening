import { isTeachingCompilerEnabled } from "@aistudy/ai";
import { CourseList } from "../../../../features/opening/courses/course-list";
import { loadTodayPage } from "../../../../features/opening/planning/load-today-page";
import { TodayDashboard } from "../../../../features/opening/planning/today-dashboard";

/** 学习首页：今天（继续、进展、我的课程）；?view=all 为完整课程管理。复习在同一入口的分区。 */
export default async function OpeningCoursesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if ((await searchParams).view === "all") return <CourseList opening />;
  return <TodayDashboard {...await loadTodayPage()} teachingCompileEnabled={isTeachingCompilerEnabled()} />;
}
