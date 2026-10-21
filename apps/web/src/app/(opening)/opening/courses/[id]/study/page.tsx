import { z } from "zod";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { isTeachingCompilerEnabled } from "@aistudy/ai";
import { CourseStudyWorkspace } from "../../../../../../features/courses/course-study-workspace";
import { loadCourseStudyContext } from "../../../../../../features/courses/server/course-study-context";
import { parseCourseStudyPracticeEntry } from "../../../../../../features/courses/course-study-query";
import { loadCourseSpanResume } from "../../../../../../features/courses/server/course-span-resume";

export default async function CourseStudyPage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ activity?: string; task?: string; retest?: string; after?: string; block?: string; contentVersion?: string; skillLabel?: string; requirementKey?: string; mode?: string; exercise?: string; variant?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const { activity, task, retest, after } = query;
  const request = new Request("http://opening.local/courses/study", { headers: await headers() });
  if (activity) {
    const lesson = await loadCourseSpanResume(request, activity);
    if (lesson) {
      if (lesson.courseId !== id) notFound();
      const destination = new URLSearchParams({ lesson: lesson.activityId });
      if (lesson.retestId) destination.set("retest", lesson.retestId);
      redirect(`/opening/courses/${lesson.courseId}/study/span?${destination}`);
    }
  }
  const anchor = z.object({ block: z.string().uuid(), contentVersion: z.coerce.number().int().positive() }).safeParse(query);
  const hasAnchor = query.block !== undefined || query.contentVersion !== undefined;
  const historicalAnchor = anchor.success ? { blockId: anchor.data.block, contentVersion: anchor.data.contentVersion } : undefined;
  const context = await loadCourseStudyContext(request, id);
  return <CourseStudyWorkspace key={`${id}:${activity ?? task ?? retest ?? after ?? query.mode ?? "current"}:${query.exercise ?? ""}:${query.variant ?? ""}:${query.skillLabel ?? ""}:${query.requirementKey ?? ""}`} historicalAnchor={historicalAnchor} historicalAnchorError={hasAnchor && !anchor.success ? "原单元链接不完整，请返回笔记核对，或明确选择继续当前断点。" : undefined} courseId={id} activityId={activity} taskId={task} retestId={retest} {...context} {...parseCourseStudyPracticeEntry(query)} teachingCompileEnabled={isTeachingCompilerEnabled()} />;
}
