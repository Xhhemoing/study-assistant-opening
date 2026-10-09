import { LegacyCourseDetail } from "../../../../../features/courses/legacy-course-detail";

type Props = { params: Promise<{ id: string }> };

export default async function CoursePage({ params }: Props) {
  const { id } = await params;
  return <LegacyCourseDetail id={id} />;
}
