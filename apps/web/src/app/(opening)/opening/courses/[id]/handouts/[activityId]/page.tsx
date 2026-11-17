import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { validConversationId } from "../../../../../../../features/opening/assistant/conversation-links";
import { loadCourseHandout } from "../../../../../../../features/opening/courses/server/course-handout";
import { CourseHandoutReader } from "../../../../../../../features/opening/courses/course-handout-reader";

export default async function CourseHandoutPage({ params, searchParams }: {
  params: Promise<{ id: string; activityId: string }>;
  searchParams?: Promise<{ conversation?: string | string[] }>;
}) {
  const [{ id, activityId }, query] = await Promise.all([params, searchParams]);
  const request = new Request("http://opening.local/courses/handouts", { headers: await headers() });
  const handout = await loadCourseHandout(request, id, activityId);
  if (!handout) notFound();
  const originalConversationId = typeof query?.conversation === "string" && validConversationId(query.conversation)
    ? query.conversation
    : undefined;
  return <CourseHandoutReader {...handout} {...(originalConversationId ? { originalConversationId } : {})} />;
}
