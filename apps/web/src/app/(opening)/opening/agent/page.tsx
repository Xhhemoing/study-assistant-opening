import { AgentWorkspace } from "@/features/opening/assistant/agent-workspace";
import { assistantEntry } from "@/features/opening/assistant/assistant-entry";
import { validConversationId } from "@/features/opening/assistant/conversation-links";

/** 助理全页（Agent）：会话列表 + 对话 + 待确认产出。页面内的「问 AI」仍走右侧抽屉。 */
export default async function AgentPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const raw = query.conversation;
  const conversation = typeof raw === "string" && validConversationId(raw) ? raw : null;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) value.forEach(item => params.append(key, item));
    else if (value !== undefined) params.set(key, value);
  }
  const entry = assistantEntry(`/opening/assistant?${params}`);
  const error = entry.error || (query.contextError === "1" ? "本次提问背景尚未就绪，请返回原内容重新打开。" : undefined)
    || (raw !== undefined && !conversation ? "对话链接无效，请从对话历史重新打开。" : undefined);
  return <AgentWorkspace key={JSON.stringify([conversation, entry.context, error])} initialConversationId={conversation} initialContext={entry.context} initialContextError={error} />;
}
