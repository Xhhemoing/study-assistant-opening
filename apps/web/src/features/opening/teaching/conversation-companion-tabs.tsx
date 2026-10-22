"use client";

import { useEffect, useState, type ReactNode } from "react";
import { OriginalConversationSlot } from "../assistant/conversation-companion";
import { ui } from "../design/ui";

/** Ordinary conversation and task-bound help share space, never their identity or context. */
export function ConversationCompanionTabs({ conversationId = null, section = "chat", tutorLabel = "本题辅导", tutorRequestKey = 0, children }: {
  conversationId?: string | null;
  section?: "chat" | "notes";
  tutorLabel?: string;
  /** Change only for an explicit request to ask the current task. */
  tutorRequestKey?: string | number;
  children: ReactNode;
}) {
  const [mode, setMode] = useState<"original" | "tutor">(conversationId !== null ? "original" : "tutor");
  const [visited, setVisited] = useState(conversationId === null);
  const showTutor = section === "notes" || mode === "tutor" || conversationId === null;
  useEffect(() => { if (conversationId !== null) setMode("original"); }, [conversationId]);
  useEffect(() => { if (showTutor) setVisited(true); }, [showTutor]);
  useEffect(() => {
    if (!tutorRequestKey) return;
    setVisited(true); setMode("tutor");
  }, [tutorRequestKey]);
  return <div className="flex h-full min-h-0 min-w-0 flex-col gap-3">
    {conversationId !== null ? <>
      <div hidden={section === "notes"} className={section === "notes" ? "hidden" : "flex shrink-0 flex-wrap gap-1"} role="group" aria-label="对话来源">
        <button type="button" className={mode === "original" ? ui.secondary : ui.quiet} aria-pressed={mode === "original"} onClick={() => setMode("original")}>原对话</button>
        <button type="button" className={mode === "tutor" ? ui.secondary : ui.quiet} aria-pressed={mode === "tutor"} onClick={() => { setVisited(true); setMode("tutor"); }}>{tutorLabel}</button>
      </div>
      <p hidden={section === "notes"} className="shrink-0 text-xs leading-6 text-text-3">原对话保留原来的提问背景；{tutorLabel}使用当前学习内容。</p>
      <div hidden={showTutor} className={showTutor ? "hidden" : "min-h-0 min-w-0 flex-1"}>
        <OriginalConversationSlot conversationId={conversationId} className="flex h-full min-h-0 min-w-0 flex-col" />
      </div>
    </> : null}
    <div hidden={!showTutor} className={showTutor ? "min-h-0 min-w-0 flex-1" : "hidden"}>{visited || showTutor ? children : null}</div>
  </div>;
}
