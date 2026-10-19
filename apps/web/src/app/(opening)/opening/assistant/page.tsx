import { AssistantView } from "@/features/opening/assistant/assistant-view";
import { materialAnalysisEntry } from "@/features/opening/library/material-analysis-link";
import { parseStudyConversationContext, studyConversationIdentity, type StudyConversationQuery } from "@/features/opening/assistant/study-conversation-context";

export default async function OpeningAssistantPage({ searchParams }: {
  searchParams: Promise<StudyConversationQuery & { conversation?: string }>;
}) {
  const { conversation, ...query } = await searchParams;
  const { context, error } = parseStudyConversationContext(query);
  const analysis = context?.sourceId ? materialAnalysisEntry(context.sourceId, context.page === undefined ? undefined : String(context.page)) : null;
  const freshContext = Boolean(context?.attemptId || context?.activityId || context?.sourceId || context?.fragment);
  return <AssistantView
    key={`${studyConversationIdentity(context)}:${freshContext ? "fresh" : conversation ?? "chat"}`}
    initialConversationId={freshContext ? null : conversation ?? null}
    initialCourseId={context?.courseId ?? null}
    {...(analysis ?? {})}
    startFresh={freshContext || !!error}
    studyContext={context ?? undefined}
    studyContextError={error ?? undefined}
  />;
}
