"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Sparkles } from "lucide-react";
import type { CurrentStudyContext } from "../assistant/current-study-context";
import { studyConversationHref, studyConversationIdentity } from "../assistant/study-conversation-context";

const prose = '[data-catalog="text"],[data-catalog="math"],[data-catalog="step"],[data-catalog="example"],[data-bilingual-problem="true"]';
const excluded = 'input,textarea,select,button,a,[contenteditable="true"],[data-inline-attempt],[hidden],[inert]';

/** Only a selection wholly inside one visible instructional region may become background text. */
export function selectedLessonExcerpt(root: HTMLElement, selection: Pick<Selection, "anchorNode" | "focusNode" | "isCollapsed" | "toString"> | null): string {
  if (!selection || selection.isCollapsed || !selection.anchorNode || !selection.focusNode) return "";
  const element = (node: Node) => node.nodeType === 1 ? node as Element : node.parentElement;
  const start = element(selection.anchorNode), end = element(selection.focusNode);
  if (!start || !end || !root.contains(start) || !root.contains(end) || start.closest(excluded) || end.closest(excluded)) return "";
  const region = start.closest(prose);
  if (!region || !root.contains(region) || end.closest(prose) !== region) return "";
  return selection.toString().trim();
}

export function SelectionAsk({ binding, children }: { binding: CurrentStudyContext | null; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const identity = binding ? `${studyConversationIdentity(binding.context)}:${binding.context.purpose ?? "learning_help"}` : "";
  const [selection, setSelection] = useState<{ identity: string; text: string } | null>(null);
  useEffect(() => {
    if (!identity) return;
    const update = () => { if (root.current) setSelection({ identity, text: selectedLessonExcerpt(root.current, window.getSelection()) }); };
    document.addEventListener("selectionchange", update);
    return () => document.removeEventListener("selectionchange", update);
  }, [identity]);
  const excerpt = selection?.identity === identity ? selection.text : "";
  const blocked = binding?.blockedReason || (binding?.isQuestion && !binding.learningAttempt ? "先保存自己的原答案，再围绕本题提问。" : undefined);
  const tooLong = excerpt.length > 4000;
  return <div ref={root} className="min-w-0 space-y-5">
    {children}
    {binding && excerpt ? <div className="fixed bottom-20 right-5 z-30 max-w-xs space-y-2 rounded-card border border-line bg-surface p-3 text-text shadow-lg" data-selection-ask-controls="true">
      {blocked || tooLong ? <><button type="button" disabled className="flex min-h-10 items-center gap-2 rounded-pill px-3 text-sm text-text-3"><Sparkles size={16} aria-hidden="true" />问 AI</button><p role="status" className="text-xs leading-5 text-text-2">{blocked || "选中的内容较长，请缩小到 4000 字以内再提问。"}</p></>
        : <a className="flex min-h-10 items-center gap-2 rounded-pill px-3 text-sm font-medium text-ai-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent" href={studyConversationHref({ ...binding.context, fragment: excerpt })} onPointerDown={event => event.preventDefault()}><Sparkles size={16} aria-hidden="true" />问 AI</a>}
    </div> : null}
  </div>;
}
