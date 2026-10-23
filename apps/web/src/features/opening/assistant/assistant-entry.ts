import { parseStudyConversationContext, studyConversationIdentity, type StudyConversationContext, type StudyConversationQuery } from "./study-conversation-context";

export type AssistantEntry = { key: string; label: string; context?: StudyConversationContext; error?: string; conversation: string | null; fresh: boolean };
export const isStudySurface = (pathname: string) => /^\/opening\/courses\/[^/]+\/study(?:\/|$)/.test(pathname);
export function sameStudyItem(left?: StudyConversationContext, right?: StudyConversationContext): boolean {
  if (!left || !right) return false;
  return (["courseId", "activityId", "blockId", "contentVersion", "attemptId", "itemVersionId", "kcMappingVersion", "sourceId", "sourceVersion", "page", "chunkId"] as const).every(key => left[key] === right[key]);
}
const contextKeys = ["courseId", "activityId", "attemptId", "itemVersionId", "kcMappingVersion", "purpose", "blockId", "contentVersion", "source", "version", "page", "chunkId", "fragment", "label", "returnTo"] as const;

/** Only named context fields enter the existing strict identity/version parser. */
export function assistantEntry(href: string, currentPath = "/opening/today"): AssistantEntry {
  const url = new URL(href, "https://study.invalid");
  const query: StudyConversationQuery = {};
  for (const key of contextKeys) if (url.searchParams.has(key)) query[key] = url.searchParams.get(key)!;
  const course = /^\/opening\/courses\/([0-9a-f-]{36})(?:\/|$)/.exec(currentPath)?.[1];
  const unbound = url.searchParams.get("context") === "none";
  if (!Object.keys(query).length && course && !unbound) query.courseId = course;
  const parsed = parseStudyConversationContext(query);
  const { context } = parsed;
  // 学习页上的题目绑定由抽屉按当前题目判断；讲解、示范、页面加载中都应能直接提问。
  const error = parsed.error ?? null;
  const fresh = unbound || Boolean(context?.attemptId || context?.activityId || context?.sourceId || context?.fragment || error);
  const conversation = fresh ? null : url.searchParams.get("conversation");
  return { key: `${studyConversationIdentity(context)}:${context?.purpose ?? "learning_help"}:${fresh ? "fresh" : conversation ?? "chat"}:${error ?? ""}`,
    label: context?.label || (context?.fragment ? "选中内容" : context?.sourceId ? "材料提问" : context?.courseId ? "课程提问" : "自由提问"),
    context: context ?? undefined, error: error ?? undefined, conversation, fresh };
}

export function assistantRedirect(query: Record<string, string | string[] | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) value.forEach(item => params.append(key, item));
    else if (value !== undefined) params.append(key, value);
  }
  params.set("ai", "1");
  return `/opening/today?${params}`;
}

export const ASSISTANT_OPEN_EVENT = "aistudy:open-assistant";
export function openAssistantDrawer(href = "/opening/assistant"): void {
  window.dispatchEvent(new CustomEvent(ASSISTANT_OPEN_EVENT, { detail: href }));
}
