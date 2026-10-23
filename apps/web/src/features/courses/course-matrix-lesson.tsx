"use client";

import { TransitionLink as Link } from "../opening/v3/motion/view-transition";
import { useCourseBundle } from "./course-detail";
import { LoadError, LoadingRows, ui } from "../opening/design/ui";
import { conversationObjectHref } from "../opening/assistant/conversation-links";
import { MatrixConceptLesson } from "../opening/teaching/matrix-lesson/matrix-concept-lesson";

export function CourseMatrixLesson({ courseId, sourceIds, sourceLoadError, interactiveEnabled, originalConversationId }: {
  originalConversationId?: string | null; courseId: string; sourceIds: string[]; sourceLoadError: boolean; interactiveEnabled: boolean;
}) {
  const { course, loading, error, reload } = useCourseBundle(courseId);
  const href = `/opening/courses/${encodeURIComponent(courseId)}`;
  if (loading) return <LoadingRows label="正在读取课程…" />;
  if (!course || error) return <div className="p-5"><Link className={ui.quiet} href={href}>返回课程</Link><LoadError message={error || "找不到这门课程。"} onRetry={reload} /></div>;
  const practiceHref = `${href}/study?mode=matrix&exercise=multiplication`;
  return <MatrixConceptLesson originalConversationId={originalConversationId} courseId={courseId} courseTitle={course.title} interactiveEnabled={interactiveEnabled}
    matrixPracticeEnabled={!course.archivedAt && !sourceLoadError && sourceIds.length > 0}
    practiceHref={conversationObjectHref(`${practiceHref}&variant=1`, originalConversationId)} delayedPracticeHref={conversationObjectHref(`${practiceHref}&variant=2`, originalConversationId)} />;
}
