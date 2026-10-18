import { headers } from "next/headers";
import { CourseMatrixLesson } from "../../../../../../../features/courses/course-matrix-lesson";
import { loadCourseStudyContext } from "../../../../../../../features/courses/server/course-study-context";

export default async function MatrixLessonPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const context = await loadCourseStudyContext(new Request("http://opening.local/courses/study/matrix", { headers: await headers() }), id);
  return <CourseMatrixLesson courseId={id} sourceIds={context.sourceIds} sourceLoadError={context.sourceLoadError} interactiveEnabled={context.matrixInteractiveEnabled} />;
}
