"use client";

import { createContext, useContext } from "react";
import { conversationObjectHref } from "./conversation-links";

/** A route's explicit reference only; no latest-chat or browser-storage lookup. */
export const ObjectConversationContext = createContext<string | null>(null);
export function useConversationObjectHref() {
  const conversationId = useContext(ObjectConversationContext);
  return (href: string) => conversationObjectHref(href, conversationId);
}
