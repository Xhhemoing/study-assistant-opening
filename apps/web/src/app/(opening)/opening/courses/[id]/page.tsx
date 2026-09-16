import { CourseDetail } from "../../../../../features/courses/course-detail";

type Props = { params: Promise<{ id: string }> };

export default async function OpeningCoursePage({ params }: Props) {
  const { id } = await params;
  return <CourseDetail id={id} />;
}
