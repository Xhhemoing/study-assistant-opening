"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Layers2, Sparkles } from "lucide-react";
import { createOpeningCardsClient } from "../cards/cards-client";
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

let cachedCards: ReturnType<typeof createOpeningCardsClient> | null = null;
const cardsClient = () => (cachedCards ??= createOpeningCardsClient());

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
  // 选中即学：问 AI / 做卡片。做卡片时冻结选中文本（聚焦输入框会清掉页面选区）。
  const [card, setCard] = useState<{ back: string; front: string; state: "edit" | "saving" | "saved" | "error"; message?: string } | null>(null);
  async function saveCard() {
    if (!card || !card.front.trim() || card.state === "saving") return;
    setCard({ ...card, state: "saving" });
    try {
      await cardsClient().createCard({ front: card.front.trim(), back: card.back, courseId: binding?.context.courseId ?? null });
      setCard({ ...card, state: "saved" });
      window.setTimeout(() => setCard(null), 1400);
    } catch (reason) {
      setCard({ ...card, state: "error", message: reason instanceof Error ? reason.message : "卡片保存失败" });
    }
  }
  return <div ref={root} className="min-w-0 space-y-5">
    {children}
    {binding && card ? <form className="fixed bottom-20 right-5 z-30 w-80 max-w-[calc(100vw-2.5rem)] space-y-2 rounded-card border border-line bg-surface p-3 text-text shadow-lg motion-safe:animate-pop" data-selection-card-form="true" onSubmit={event => { event.preventDefault(); void saveCard(); }}>
      <label className="block text-meta text-text-2">卡片正面（问自己什么）<input autoFocus className="mt-1 min-h-10 w-full rounded-ctl border border-line bg-surface px-3 text-ui text-text" value={card.front} maxLength={500} onChange={event => setCard({ ...card, front: event.target.value, state: card.state === "error" ? "edit" : card.state })} /></label>
      <p className="line-clamp-3 rounded-ctl bg-surface-2 px-3 py-2 text-meta text-text-2">背面：{card.back}</p>
      {card.state === "error" ? <p role="alert" className="text-meta text-danger">{card.message}</p> : null}
      <div className="flex justify-end gap-1">
        <button type="button" className="min-h-9 rounded-pill px-3 text-ui text-text-2 hover:bg-surface-2" onClick={() => setCard(null)}>取消</button>
        <button type="submit" disabled={!card.front.trim() || card.state === "saving" || card.state === "saved"} className="min-h-9 rounded-pill bg-ink px-3 text-ui font-medium text-on-ink disabled:opacity-50">{card.state === "saving" ? "保存中…" : card.state === "saved" ? "已加入卡片" : "加入卡片"}</button>
      </div>
    </form> : binding && excerpt ? <div className="fixed bottom-20 right-5 z-30 max-w-xs space-y-2 rounded-card border border-line bg-surface p-1.5 text-text shadow-lg motion-safe:animate-pop" data-selection-ask-controls="true">
      {blocked || tooLong ? <><button type="button" disabled className="flex min-h-10 items-center gap-2 rounded-pill px-3 text-sm text-text-3"><Sparkles size={16} aria-hidden="true" />问 AI</button><p role="status" className="px-2 pb-1 text-xs leading-5 text-text-2">{blocked || "选中的内容较长，请缩小到 4000 字以内再提问。"}</p></>
        : <div className="flex items-center gap-0.5"><a className="flex min-h-10 items-center gap-2 rounded-pill px-3 text-sm font-medium text-ai-1 hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent" href={studyConversationHref({ ...binding.context, fragment: excerpt })} onPointerDown={event => event.preventDefault()}><Sparkles size={16} aria-hidden="true" />问 AI</a>
          <button type="button" className="flex min-h-10 items-center gap-2 rounded-pill px-3 text-sm text-text-2 hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent" onPointerDown={event => event.preventDefault()} onClick={() => setCard({ back: excerpt.slice(0, 4000), front: "", state: "edit" })}><Layers2 size={16} aria-hidden="true" />做卡片</button></div>}
    </div> : null}
  </div>;
}
