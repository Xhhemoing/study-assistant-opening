import { AssistantSession } from "@/features/opening/assistant/assistant-session";
import { assistantEntry } from "@/features/opening/assistant/assistant-entry";
import { ConversationHistory } from "@/features/opening/start/conversation-history";

export default async function OpeningAssistantPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) value.forEach(item => params.append(key, item));
    else if (value !== undefined) params.append(key, value);
  }
  const entry = assistantEntry(`/opening/assistant?${params}`);
  if (entry.conversation || entry.context || entry.error || entry.fresh) return <AssistantSession entry={entry} embedded={false} />;
  return <ConversationHistory />;
}
