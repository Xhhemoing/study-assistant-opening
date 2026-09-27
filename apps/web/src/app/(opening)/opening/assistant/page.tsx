import { AssistantView } from "@/features/opening/assistant/assistant-view";

export default async function OpeningAssistantPage({
  searchParams,
}: {
  searchParams: Promise<{ conversation?: string }>;
}) {
  const { conversation } = await searchParams;
  return (
    <main className="mx-auto min-h-screen max-w-3xl p-4">
      <AssistantView initialConversationId={conversation ?? null} />
    </main>
  );
}
