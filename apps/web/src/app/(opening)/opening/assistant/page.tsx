import { AssistantView } from "@/features/opening/assistant/assistant-view";
import { parseAssistantCourseIdParam } from "@/features/opening/assistant/course-source-selection";
import { materialAnalysisEntry } from "@/features/opening/library/material-analysis-link";

export default async function OpeningAssistantPage({
  searchParams,
}: {
  searchParams: Promise<{ conversation?: string; source?: string; page?: string; courseId?: string }>;
}) {
  const { conversation, source, page, courseId: courseIdParam } = await searchParams;
  const analysis = materialAnalysisEntry(source, page);
  const initialCourseId = parseAssistantCourseIdParam(courseIdParam);
  return (
    <AssistantView
      key={analysis ? `${source}:${page}` : `${conversation ?? "chat"}:${initialCourseId ?? ""}`}
      initialConversationId={analysis ? null : conversation ?? null}
      initialCourseId={initialCourseId}
      {...(analysis ?? {})}
    />
  );
}
