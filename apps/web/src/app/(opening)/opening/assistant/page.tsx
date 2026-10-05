import { AssistantView } from "@/features/opening/assistant/assistant-view";
import { materialAnalysisEntry } from "@/features/opening/library/material-analysis-link";

export default async function OpeningAssistantPage({
  searchParams,
}: {
  searchParams: Promise<{ conversation?: string; source?: string; page?: string }>;
}) {
  const { conversation, source, page } = await searchParams;
  const analysis = materialAnalysisEntry(source, page);
  return <AssistantView key={analysis ? `${source}:${page}` : conversation ?? "chat"} initialConversationId={analysis ? null : conversation ?? null} {...(analysis ?? {})} />;
}
