import { headers } from "next/headers";
import { CourseMatrixLesson } from "../../../../../../../features/courses/course-matrix-lesson";
import { loadCourseStudyContext } from "../../../../../../../features/courses/server/course-study-context";

export default async function MatrixLessonPage({ params, searchParams = Promise.resolve({}) }: { params: Promise<{ id: string }>; searchParams?: Promise<{ conversation?: string }> }) {
  const { id } = await params;
  const { conversation } = await searchParams;
  const context = await loadCourseStudyContext(new Request("http://opening.local/courses/study/matrix", { headers: await headers() }), id);
  return <CourseMatrixLesson originalConversationId={conversation} courseId={id} sourceIds={context.sourceIds} sourceLoadError={context.sourceLoadError} interactiveEnabled={context.matrixInteractiveEnabled} />;
}
