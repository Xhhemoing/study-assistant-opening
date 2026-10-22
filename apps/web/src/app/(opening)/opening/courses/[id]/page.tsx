import { ConversationObjectFrame } from "../../../../../features/opening/assistant/conversation-object-frame";
import { validConversationId } from "../../../../../features/opening/assistant/conversation-links";
import { CourseDetail } from "../../../../../features/courses/course-detail";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ mode?: string; conversation?: string | string[] }> };

export default async function OpeningCoursePage({ params, searchParams }: Props) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  return <ConversationObjectFrame conversation={query.conversation}><CourseDetail id={id} mode={query.mode === "sprint" ? "sprint" : undefined} conversationId={typeof query.conversation === "string" && validConversationId(query.conversation) ? query.conversation : undefined} /></ConversationObjectFrame>;
}
