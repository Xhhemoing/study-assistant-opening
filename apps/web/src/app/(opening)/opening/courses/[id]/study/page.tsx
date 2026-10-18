import { headers } from "next/headers";
import { isTeachingCompilerEnabled } from "@aistudy/ai";
import { CourseStudyWorkspace } from "../../../../../../features/courses/course-study-workspace";
import { loadCourseStudyContext } from "../../../../../../features/courses/server/course-study-context";

export default async function CourseStudyPage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ activity?: string; task?: string; retest?: string; after?: string }>;
}) {
  const { id } = await params;
  const { activity, task, retest, after } = await searchParams;
  const context = await loadCourseStudyContext(new Request("http://opening.local/courses/study", { headers: await headers() }), id);
  return <CourseStudyWorkspace key={`${id}:${activity ?? task ?? retest ?? after ?? "current"}`} courseId={id} activityId={activity} taskId={task} retestId={retest} {...context} teachingCompileEnabled={isTeachingCompilerEnabled()} />;
}
