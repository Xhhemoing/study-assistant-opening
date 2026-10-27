"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Focus, Maximize2 } from "lucide-react";
import type { CurrentStudyContext } from "../assistant/current-study-context";
import { useWorkspaceLayout } from "../shell/workspace-layout-context";
import { ConversationCompanionTabs } from "./conversation-companion-tabs";
import { StudyContextTools } from "./study-context-tools";
import { StudyToolsPanel, StudyToolsToggle } from "./study-tools-panel";
import { LessonSelectionAskContext } from "./selection-ask";
import { studyConversationIdentity } from "../assistant/study-conversation-context";
import { TransitionLink as Link } from "../v3/motion/view-transition";
import { MaterialLibrary } from "../library/material-library";
import { createOpeningApi } from "../client/api";
import { ui } from "../design/ui";

/** Existing lessons keep their own content/attempt tree and share the single auxiliary surface. */
export function LessonCompanionWorkspace({ originalConversationId = null, binding, title, returnHref, progress, outline, children }: {
  originalConversationId?: string | null;
  binding: CurrentStudyContext;
  title: string;
  returnHref: string;
  progress: { current: number; total: number };
  outline: ReactNode;
  children: ReactNode;
}) {
  const [panel, setPanel] = useState<string | null>(originalConversationId !== null ? "chat" : null);
  const [request, setRequest] = useState<{ id: string; text: string; scope: string } | null>(null);
  const sequence = useRef(0);
  const outlineMenu = useRef<HTMLDetailsElement>(null);
  const api = useMemo(() => createOpeningApi(), []);
  const scope = studyConversationIdentity(binding.context);
  const askRequest = request?.scope === scope ? request : undefined;
  const { focusMode, setFocusMode, toggleFocusMode } = useWorkspaceLayout();
  useEffect(() => { if (originalConversationId !== null) setPanel("chat"); }, [originalConversationId]);
  const shared = <ConversationCompanionTabs conversationId={originalConversationId} section={panel === "notes" ? "notes" : "chat"} tutorRequestKey={askRequest?.id} tutorLabel={binding.isQuestion ? "本题辅导" : "本节提问"}>
    <StudyContextTools context={binding.context} isQuestion={binding.isQuestion} learningAttempt={binding.learningAttempt}
      questionBlockedReason={binding.blockedReason} section={panel === "notes" ? "notes" : "chat"} askRequest={askRequest} />
  </ConversationCompanionTabs>;
  const panels = [
    { id: "chat", label: "对话", mountKey: "context", content: shared },
    { id: "notes", label: "笔记", mountKey: "context", content: shared },
    { id: "materials", label: "资料", content: binding.context.courseId
      ? <MaterialLibrary api={api} courseId={binding.context.courseId} />
      : <p className="text-sm text-text-2">本节未关联课程资料。</p> },
  ];
  const changePanel = (next: string | null) => { if (next) setFocusMode(false); setPanel(next); };
  return <LessonSelectionAskContext.Provider value={text => {
    setRequest({ id: `${scope}:${++sequence.current}`, text: `请补充解释这段内容：\n${text}`, scope });
    setFocusMode(false); setPanel("chat");
  }}><section className="flex h-full min-h-0 flex-col">
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <Link className={ui.quiet} href={returnHref} aria-label="返回课程"><ArrowLeft size={16} aria-hidden="true" /></Link>
        <details ref={outlineMenu} className="relative min-w-0">
          <summary aria-label="选择学习单元" className="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-2 rounded-md px-2 focus-visible:ring-2 focus-visible:ring-accent">
            <h1 className="truncate text-sm font-semibold">{title}</h1><span className="text-xs text-text-3">单元 {progress.current} / {progress.total}</span>
          </summary>
          <div className="absolute left-0 top-full z-20 max-h-80 w-72 max-w-[80vw] overflow-y-auto rounded-xl border border-line bg-surface p-3 shadow-lg" onClick={event => {
            if ((event.target as Element).closest("button,a") && outlineMenu.current) outlineMenu.current.open = false;
          }}>{outline}</div>
        </details>
      </div>
      <div className="flex items-center gap-2"><button type="button" className={ui.icon} aria-label={focusMode ? "退出专注学习" : "专注学习"} aria-pressed={focusMode} onClick={toggleFocusMode}>{focusMode ? <Maximize2 size={16} aria-hidden="true" /> : <Focus size={16} aria-hidden="true" />}</button>
        <StudyToolsToggle panels={panels} activePanel={panel} suspended={focusMode} onPanelChange={changePanel} />
      </div>
    </header>
    <div className="min-h-0 flex-1"><StudyToolsPanel fillHeight showToolbar={false} preferContentOnNarrowEntry={originalConversationId !== null} activePanel={panel} suspended={focusMode} onPanelChange={changePanel} panels={panels}>{children}</StudyToolsPanel></div>
  </section></LessonSelectionAskContext.Provider>;
}
