import { z } from "zod";
import { NewDocument } from "../../../../../features/editor/new-document";
import { CourseNote } from "../../../../../features/courses/course-note";

export default async function OpeningNewNotePage({ searchParams }: { searchParams: Promise<{ courseId?: string }> }) {
  const query = await searchParams;
  const course = z.string().uuid().safeParse(query.courseId);
  if (query.courseId && !course.success) return <p role="alert" className="p-5">课程入口无效，请返回原课程重新打开；尚未创建笔记。</p>;
  return course.success ? <CourseNote courseId={course.data} /> : <NewDocument basePath="/opening/library" />;
}
