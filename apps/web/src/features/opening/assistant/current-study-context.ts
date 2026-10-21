"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import type { LearningAttempt } from "@aistudy/contracts";
import type { StudyConversationContext } from "./study-conversation-context";

export type CurrentStudyContext = {
  context: StudyConversationContext;
  learningAttempt?: LearningAttempt | null;
  isQuestion: boolean;
  blockedReason?: string;
};
type BoundContext = CurrentStudyContext & { pathname: string; owner: symbol };
let current: BoundContext | null = null;
const listeners = new Set<() => void>();
const publish = () => listeners.forEach(listener => listener());
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** Register only the workspace's current item, never each card in a list. */
export function useStudyAssistantContext(value: CurrentStudyContext | null) {
  const owner = useRef(Symbol("study-context"));
  useEffect(() => {
    if (!value) return;
    const token = owner.current;
    current = { ...value, pathname: window.location.pathname, owner: token };
    publish();
    return () => { if (current?.owner === token) { current = null; publish(); } };
  }, [value]);
}

export function useCurrentStudyContext() {
  return useSyncExternalStore(subscribe, () => current, () => null);
}
