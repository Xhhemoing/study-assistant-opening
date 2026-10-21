import { redirect } from "next/navigation";
import { SprintCourseChooser } from "../../../../features/opening/exam-sprint/sprint-course-chooser";
import { sprintCourseHref, type SprintSearch } from "../../../../features/opening/exam-sprint/sprint-course-route";

export default async function OpeningSprintPage({ searchParams }: { searchParams: Promise<SprintSearch> }) {
  const search = await searchParams;
  const href = sprintCourseHref(search);
  if (href) redirect(href);
  return <SprintCourseChooser invalidCourse={search.courseId !== undefined} />;
}
