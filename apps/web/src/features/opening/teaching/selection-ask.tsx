"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Sparkles } from "lucide-react";
import type { CurrentStudyContext } from "../assistant/current-study-context";
import { studyConversationIdentity } from "../assistant/study-conversation-context";

export const LessonSelectionAskContext = createContext<((text: string) => void) | null>(null);

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

export function SelectionAsk({ binding, children, onAsk }: { binding: CurrentStudyContext | null; children: ReactNode; onAsk?: (text: string) => void }) {
  const inheritedAsk = useContext(LessonSelectionAskContext);
  const ask = onAsk ?? inheritedAsk;
  const root = useRef<HTMLDivElement>(null);
  const anchor = useRef<Element | null>(null);
  const identity = binding ? `${studyConversationIdentity(binding.context)}:${binding.context.purpose ?? "learning_help"}` : "";
  const [selection, setSelection] = useState<{ identity: string; text: string } | null>(null);
  useEffect(() => {
    if (!identity) return;
    const update = () => {
      if (!root.current) return;
      const native = window.getSelection();
      const text = selectedLessonExcerpt(root.current, native);
      anchor.current?.classList?.remove("[anchor-name:--lesson-selection]");
      const node = native?.anchorNode;
      anchor.current = text ? (node?.nodeType === 1 ? node as Element : node?.parentElement ?? null) : null;
      anchor.current?.classList?.add("[anchor-name:--lesson-selection]");
      setSelection({ identity, text });
    };
    document.addEventListener("selectionchange", update);
    return () => { document.removeEventListener("selectionchange", update); anchor.current?.classList?.remove("[anchor-name:--lesson-selection]"); };
  }, [identity]);
  const excerpt = selection?.identity === identity ? selection.text : "";
  const blocked = binding?.blockedReason || (binding?.isQuestion && !binding.learningAttempt ? "先保存自己的原答案，再围绕本题提问。" : undefined);
  const tooLong = excerpt.length > 4000;
  return <div ref={root} className="min-w-0 space-y-5">
    {children}
    {binding && excerpt ? <div className="sticky bottom-0 z-30 space-y-2 rounded-card border border-line bg-popover p-3 text-text shadow-lg [@media(pointer:fine)]:fixed [@media(pointer:fine)]:bottom-20 [@media(pointer:fine)]:right-5 [@media(pointer:fine)]:max-w-xs [@media(pointer:fine)]:[@supports(anchor-name:--lesson-selection)]:[position-anchor:--lesson-selection] [@media(pointer:fine)]:[@supports(anchor-name:--lesson-selection)]:[position-area:block-end] [@media(pointer:fine)]:[@supports(anchor-name:--lesson-selection)]:[position-try-fallbacks:flip-block,flip-inline] [@media(pointer:fine)]:[@supports(anchor-name:--lesson-selection)]:bottom-auto [@media(pointer:fine)]:[@supports(anchor-name:--lesson-selection)]:right-auto" data-selection-ask-controls="true">
      {blocked || tooLong ? <><button type="button" disabled className="flex min-h-10 items-center gap-2 rounded-pill px-3 text-sm text-text-3"><Sparkles size={16} aria-hidden="true" />问 AI</button><p role="status" className="text-xs leading-5 text-text-2">{blocked || "选中的内容较长，请缩小到 4000 字以内再提问。"}</p></>
        : <button type="button" disabled={!ask} className="flex min-h-11 items-center gap-2 rounded-pill px-3 text-sm font-medium text-ai-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring" onPointerDown={event => event.preventDefault()} onClick={() => ask?.(excerpt)}><Sparkles size={16} aria-hidden="true" />问选中内容</button>}
    </div> : null}
  </div>;
}
