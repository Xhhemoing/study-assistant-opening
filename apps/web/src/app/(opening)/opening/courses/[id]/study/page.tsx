import { z } from "zod";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { isTeachingCompilerEnabled } from "@aistudy/ai";
import { validConversationId } from "../../../../../../features/opening/assistant/conversation-links";
import { CourseStudyWorkspace } from "../../../../../../features/opening/courses/course-study-workspace";
import { loadCourseStudyContext } from "../../../../../../features/opening/courses/server/course-study-context";
import { courseStudyStandaloneActivity, parseCourseStudyPracticeEntry } from "../../../../../../features/opening/courses/course-study-query";
import { loadCourseSpanResume } from "../../../../../../features/opening/courses/server/course-span-resume";

export default async function CourseStudyPage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ activity?: string; task?: string; retest?: string; after?: string; block?: string; contentVersion?: string; skillLabel?: string; requirementKey?: string; mode?: string; exercise?: string; variant?: string; sourceId?: string; conversation?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const { activity, task, retest, after } = query;
  const conversation = z.string().uuid().safeParse(query.conversation);
  const originalConversationId =
    conversation.success && validConversationId(conversation.data) ? conversation.data : undefined;
  const request = new Request("http://opening.local/courses/study", { headers: await headers() });
  const standaloneActivity = courseStudyStandaloneActivity(query);
  if (standaloneActivity) {
    const lesson = await loadCourseSpanResume(request, standaloneActivity);
    if (lesson) {
      if (lesson.courseId !== id) notFound();
      const destination = new URLSearchParams({ lesson: lesson.activityId });
      if (lesson.retestId) destination.set("retest", lesson.retestId);
      if (originalConversationId !== undefined) destination.set("conversation", originalConversationId);
      redirect(`/opening/courses/${lesson.courseId}/study/span?${destination}`);
    }
  }
  const anchor = z.object({ block: z.string().uuid(), contentVersion: z.coerce.number().int().positive() }).safeParse(query);
  const hasAnchor = query.block !== undefined || query.contentVersion !== undefined;
  const historicalAnchor = anchor.success ? { blockId: anchor.data.block, contentVersion: anchor.data.contentVersion } : undefined;
  const practiceEntry = parseCourseStudyPracticeEntry(query);
  const context = await loadCourseStudyContext(request, id, practiceEntry.initialMatrixExercise?.sourceId);
  return <CourseStudyWorkspace key={`${id}:${activity ?? ""}:${task ?? ""}:${retest ?? ""}:${after ?? ""}:${query.mode ?? "current"}:${query.exercise ?? ""}:${query.variant ?? ""}:${query.sourceId ?? ""}:${query.skillLabel ?? ""}:${query.requirementKey ?? ""}`} originalConversationId={originalConversationId} historicalAnchor={historicalAnchor} historicalAnchorError={hasAnchor && !anchor.success ? "原单元链接不完整，请返回笔记核对，或明确选择继续当前断点。" : undefined} courseId={id} activityId={activity} taskId={task} retestId={retest} {...context} {...practiceEntry} teachingCompileEnabled={isTeachingCompilerEnabled()} />;
}
