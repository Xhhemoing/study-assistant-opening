import { ConversationObjectFrame } from "../../../../../../features/opening/assistant/conversation-object-frame";
import { headers } from "next/headers";
import { uuidSchema } from "@aistudy/contracts";
import { requireOpeningScope } from "../../../../../../features/opening/runtime";
import { getCourseExamService } from "../../../../../../features/opening/exam-sprint/course-exam-runtime";
import { CourseExamView } from "../../../../../../features/opening/exam-sprint/course-exam-view";

export default async function CourseExamPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ conversation?: string | string[] }> }) {
  const [route, query] = await Promise.all([params, searchParams]);
  const courseId = uuidSchema.parse(route.id);
  const request = new Request("http://opening.local/course-exam", { headers: await headers() });
  const { scope, sql } = await requireOpeningScope(request);
  return <ConversationObjectFrame conversation={query.conversation}><CourseExamView initial={await getCourseExamService(sql).read(scope, courseId)} /></ConversationObjectFrame>;
}
