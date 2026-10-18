"use client";

import Link from "next/link";
import { useCourseBundle } from "./course-detail";
import { LoadError, LoadingRows, ui } from "../opening/design/ui";
import { MatrixConceptLesson } from "../opening/teaching/matrix-lesson/matrix-concept-lesson";

export function CourseMatrixLesson({ courseId, sourceIds, sourceLoadError, interactiveEnabled }: {
  courseId: string; sourceIds: string[]; sourceLoadError: boolean; interactiveEnabled: boolean;
}) {
  const { course, loading, error, reload } = useCourseBundle(courseId);
  const href = `/opening/courses/${encodeURIComponent(courseId)}`;
  if (loading) return <LoadingRows label="正在读取课程…" />;
  if (!course || error) return <div className="p-5"><Link className={ui.quiet} href={href}>返回课程</Link><LoadError message={error || "找不到这门课程。"} onRetry={reload} /></div>;
  const practiceHref = `${href}/study?mode=matrix&exercise=multiplication`;
  return <MatrixConceptLesson courseId={courseId} courseTitle={course.title} interactiveEnabled={interactiveEnabled}
    matrixPracticeEnabled={!course.archivedAt && !sourceLoadError && sourceIds.length > 0}
    practiceHref={`${practiceHref}&variant=1`} delayedPracticeHref={`${practiceHref}&variant=2`} />;
}
