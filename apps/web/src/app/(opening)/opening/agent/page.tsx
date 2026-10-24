import { AgentWorkspace } from "@/features/opening/assistant/agent-workspace";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 助理全页（Agent）：会话列表 + 对话 + 待确认产出。页面内的「问 AI」仍走右侧抽屉。 */
export default async function AgentPage({ searchParams }: { searchParams: Promise<{ conversation?: string | string[] }> }) {
  const raw = (await searchParams).conversation;
  const conversation = typeof raw === "string" && UUID.test(raw) ? raw : null;
  return <AgentWorkspace initialConversationId={conversation} />;
}
