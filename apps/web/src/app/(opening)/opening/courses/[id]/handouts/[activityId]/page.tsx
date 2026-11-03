import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { loadCourseHandout } from "../../../../../../../features/opening/courses/server/course-handout";
import { CourseHandoutReader } from "../../../../../../../features/opening/courses/course-handout-reader";

export default async function CourseHandoutPage({ params }: {
  params: Promise<{ id: string; activityId: string }>;
}) {
  const { id, activityId } = await params;
  const request = new Request("http://opening.local/courses/handouts", { headers: await headers() });
  const handout = await loadCourseHandout(request, id, activityId);
  if (!handout) notFound();
  return <CourseHandoutReader {...handout} />;
}
