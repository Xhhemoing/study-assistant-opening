const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const validConversationId = (value: string): boolean => uuid.test(value);

/** Carry only the conversation reference; target ownership is still checked by its read APIs. */
export function conversationObjectHref(href: string, conversationId?: string | null): string {
  if (!conversationId || !validConversationId(conversationId) || !href.startsWith("/") || href.startsWith("//") || href.includes("\\")) return href;
  const url = new URL(href, "https://study.invalid");
  const supported = ["/opening/library", "/opening/practice", "/opening/cards", "/opening/review", "/opening/sprint"].includes(url.pathname)
    || /^\/opening\/library\/[0-9a-f-]{36}$/.test(url.pathname)
    || /^\/opening\/courses\/[0-9a-f-]{36}(?:\/study(?:\/span|\/matrix)?|\/exam)?$/.test(url.pathname);
  if (!supported || url.origin !== "https://study.invalid") return href;
  url.searchParams.set("conversation", conversationId);
  return `${url.pathname}${url.search}${url.hash}`;
}
