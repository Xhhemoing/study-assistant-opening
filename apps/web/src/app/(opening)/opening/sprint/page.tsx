import { ConversationObjectFrame } from "../../../../features/opening/assistant/conversation-object-frame";
import { validConversationId } from "../../../../features/opening/assistant/conversation-links";
import { CourseDetail } from "../../../../features/opening/courses/course-detail";
import { SprintCourseChooser } from "../../../../features/opening/exam-sprint/sprint-course-chooser";
import { sprintCourseId, type SprintSearch } from "../../../../features/opening/exam-sprint/sprint-course-route";

export default async function OpeningSprintPage({ searchParams }: { searchParams: Promise<SprintSearch> }) {
  const search = await searchParams;
  const courseId = sprintCourseId(search);
  const conversationId = typeof search.conversation === "string" && validConversationId(search.conversation) ? search.conversation : undefined;
  return <ConversationObjectFrame conversation={search.conversation}>{courseId
    ? <CourseDetail id={courseId} mode="sprint" conversationId={conversationId} />
    : <SprintCourseChooser invalidCourse={search.courseId !== undefined} />}</ConversationObjectFrame>;
}
