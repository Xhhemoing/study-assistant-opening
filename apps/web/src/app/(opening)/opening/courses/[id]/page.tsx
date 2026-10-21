import { CourseDetail } from "../../../../../features/courses/course-detail";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ mode?: string }> };

export default async function OpeningCoursePage({ params, searchParams }: Props) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  return <CourseDetail id={id} mode={query.mode === "sprint" ? "sprint" : undefined} />;
}
