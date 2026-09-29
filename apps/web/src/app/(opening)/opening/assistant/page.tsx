import { AssistantView } from "@/features/opening/assistant/assistant-view";

export default async function OpeningAssistantPage({
  searchParams,
}: {
  searchParams: Promise<{ conversation?: string }>;
}) {
  const { conversation } = await searchParams;
  return <AssistantView initialConversationId={conversation ?? null} />;
}
