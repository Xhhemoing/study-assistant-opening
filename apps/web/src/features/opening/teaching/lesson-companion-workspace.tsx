"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { CurrentStudyContext } from "../assistant/current-study-context";
import { useWorkspaceLayout } from "../shell/workspace-layout-context";
import { ConversationCompanionTabs } from "./conversation-companion-tabs";
import { StudyContextTools } from "./study-context-tools";
import { StudyToolsPanel } from "./study-tools-panel";
import { LessonSelectionAskContext } from "./selection-ask";
import { studyConversationIdentity } from "../assistant/study-conversation-context";

/** Existing lessons keep their own content/attempt tree and share the single auxiliary surface. */
export function LessonCompanionWorkspace({ originalConversationId = null, binding, outline, children }: {
  originalConversationId?: string | null;
  binding: CurrentStudyContext;
  outline: ReactNode;
  children: ReactNode;
}) {
  const [panel, setPanel] = useState<string | null>(originalConversationId !== null ? "chat" : null);
  const [request, setRequest] = useState<{ id: string; text: string; scope: string } | null>(null);
  const sequence = useRef(0);
  const scope = studyConversationIdentity(binding.context);
  const askRequest = request?.scope === scope ? request : undefined;
  const { focusMode, setFocusMode } = useWorkspaceLayout();
  useEffect(() => { if (originalConversationId !== null) setPanel("chat"); }, [originalConversationId]);
  const shared = <ConversationCompanionTabs conversationId={originalConversationId} section={panel === "notes" ? "notes" : "chat"} tutorRequestKey={askRequest?.id} tutorLabel={binding.isQuestion ? "本题辅导" : "本节提问"}>
    <StudyContextTools context={binding.context} isQuestion={binding.isQuestion} learningAttempt={binding.learningAttempt}
      questionBlockedReason={binding.blockedReason} section={panel === "notes" ? "notes" : "chat"} askRequest={askRequest} />
  </ConversationCompanionTabs>;
  return <LessonSelectionAskContext.Provider value={text => {
    setRequest({ id: `${scope}:${++sequence.current}`, text: `请补充解释这段内容：\n${text}`, scope });
    setFocusMode(false); setPanel("chat");
  }}><StudyToolsPanel fillHeight preferContentOnNarrowEntry={originalConversationId !== null} activePanel={panel} suspended={focusMode} onPanelChange={next => { if (next) setFocusMode(false); setPanel(next); }} panels={[
    { id: "chat", label: "对话", mountKey: "context", content: shared },
    { id: "outline", label: "目录", content: outline },
    { id: "notes", label: "笔记", mountKey: "context", content: shared },
  ]}>{children}</StudyToolsPanel></LessonSelectionAskContext.Provider>;
}
