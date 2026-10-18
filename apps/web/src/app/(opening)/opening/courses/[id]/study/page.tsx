import { headers } from "next/headers";
import { isTeachingCompilerEnabled } from "@aistudy/ai";
import { CourseStudyWorkspace } from "../../../../../../features/courses/course-study-workspace";
import { loadCourseStudyContext } from "../../../../../../features/courses/server/course-study-context";
import { parseCourseStudyPracticeEntry } from "../../../../../../features/courses/course-study-query";

export default async function CourseStudyPage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ activity?: string; task?: string; retest?: string; after?: string; mode?: string; exercise?: string; variant?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const { activity, task, retest, after } = query;
  const context = await loadCourseStudyContext(new Request("http://opening.local/courses/study", { headers: await headers() }), id);
  return <CourseStudyWorkspace key={`${id}:${activity ?? task ?? retest ?? after ?? query.mode ?? "current"}:${query.exercise ?? ""}:${query.variant ?? ""}`} courseId={id} activityId={activity} taskId={task} retestId={retest} {...context} {...parseCourseStudyPracticeEntry(query)} teachingCompileEnabled={isTeachingCompilerEnabled()} />;
}
