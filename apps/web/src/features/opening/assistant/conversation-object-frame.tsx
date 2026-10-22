"use client";

import { useEffect, useState, type ReactNode } from "react";
import { OriginalConversationSlot } from "./conversation-companion";
import { validConversationId } from "./conversation-links";
import { ObjectConversationContext } from "./conversation-object-context";
import { StudyToolsPanel } from "../teaching/study-tools-panel";
import { useWorkspaceLayout } from "../shell/workspace-layout-context";
import { ui } from "../design/ui";

/** One route-level companion. Card/task widgets inside it keep their own canonical identity. */
export function ConversationObjectFrame({ conversation, children }: { conversation?: string | string[] | null; children: ReactNode }) {
  if (conversation == null) return children;
  if (typeof conversation !== "string" || !validConversationId(conversation)) return <div className="flex h-full min-h-0 min-w-0 flex-col"><p role="alert" className="shrink-0 px-4 py-2 text-sm text-danger">原对话链接无效，请从对话历史重新打开。当前内容仍可使用。</p><div className="min-h-0 flex-1">{children}</div></div>;
  return <ObjectConversationContext.Provider value={conversation}><ObjectFrame conversationId={conversation}>{children}</ObjectFrame></ObjectConversationContext.Provider>;
}

function ObjectFrame({ conversationId, children }: { conversationId: string; children: ReactNode }) {
  const { focusMode, toggleFocusMode, setFocusMode } = useWorkspaceLayout();
  const [panel, setPanel] = useState<string | null>("original");
  useEffect(() => { setPanel("original"); }, [conversationId]);
  function selectPanel(next: string | null) { if (next) setFocusMode(false); setPanel(next); }
  return <div className="relative flex h-full min-h-0 min-w-0 flex-col" data-conversation-object="true">
    <button type="button" className={`${ui.quiet} absolute right-4 top-0 z-10`} aria-pressed={focusMode} onClick={toggleFocusMode}>{focusMode ? "退出专注" : "专注"}</button>
    <StudyToolsPanel fillHeight preferContentOnNarrowEntry suspended={focusMode} activePanel={panel} onPanelChange={selectPanel} toolbarClassName="px-4 pr-24 sm:px-8 sm:pr-28"
      panels={[{ id: "original", label: "原对话", content: <OriginalConversationSlot conversationId={conversationId} className="flex h-full min-h-0 min-w-0 flex-col" /> }]}>
      {children}
    </StudyToolsPanel>
  </div>;
}
