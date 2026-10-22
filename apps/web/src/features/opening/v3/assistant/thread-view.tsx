"use client";
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { ArrowUp, FileText, PenLine } from "lucide-react";
import { TransitionLink } from "../motion/view-transition";

const DOTS = ["bg-ai-1", "bg-ai-2 [animation-delay:200ms]", "bg-ai-3 [animation-delay:400ms]"];

export type ObjectRef = { kind: "problem" | "doc"; label: string; meta: string; href: string };
export type ThreadMessage = { id: string; role: "user" | "ai"; text: string; objects?: ObjectRef[] };

/** 回答中的对象卡：点击才打开；标题承接到目标页（共享元素过渡）。 */
export function ObjectCard({ object }: { object: ObjectRef }) {
  const Icon = object.kind === "doc" ? FileText : PenLine;
  return (
    <TransitionLink href={object.href} vtSource="object-title" direction="forward"
      className="group flex items-center gap-3 rounded-md border border-line bg-surface px-3 py-2.5 transition-[border-color,background-color,transform] duration-(--duration-micro) hover:border-line-strong hover:bg-surface-2 active:scale-[0.99]">
      <Icon size={18} aria-hidden="true" className={object.kind === "doc" ? "text-obj-1" : "text-obj-3"} />
      <span className="min-w-0 flex-1"><span data-vt-title className="block truncate text-[15px] text-text">{object.label}</span><span className="block truncate text-[13px] text-text-2">{object.meta}</span></span>
      <span aria-hidden="true" className="text-text-3 transition-transform duration-(--duration-micro) group-hover:translate-x-0.5">→</span>
    </TransitionLink>
  );
}

type ThreadViewProps = {
  messages: ThreadMessage[];
  pending: boolean;
  draft: string;
  onDraftChange: (text: string) => void;
  onSend: () => void;
  /** compact：辅助区内；否则居中纯问答 */
  compact?: boolean;
  contextLabel?: string;
  inputId: string;
  emptyHint?: ReactNode;
};

/**
 * 对话视图（纯问答与辅助区共用）。动效：新消息上浮淡入；回答中三点呼吸；
 * 居中模式的输入框与开始页共享 view-transition-name，从中央落到底部。
 */
export function ThreadView({ messages, pending, draft, onDraftChange, onSend, compact = false, contextLabel, inputId, emptyHint }: ThreadViewProps) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" }); }, [messages.length, pending]);
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    onSend();
  }
  return (
    <div className={`flex h-full flex-col ${compact ? "" : "mx-auto w-full max-w-[720px]"}`}>
      <div className={`min-h-0 flex-1 space-y-5 overflow-y-auto ${compact ? "p-4" : "px-4 py-8"}`}>
        {messages.length === 0 && emptyHint}
        {messages.map(message => message.role === "user" ? (
          <div key={message.id} className="ml-auto w-fit max-w-[85%] rounded-card bg-surface-2 px-4 py-2.5 text-[15px] leading-7 text-text motion-safe:animate-enter">{message.text}</div>
        ) : (
          <div key={message.id} className="space-y-3 motion-safe:animate-enter">
            <p className={`leading-7 text-text ${compact ? "text-[15px]" : "prose-reading"}`}>{message.text}</p>
            {message.objects?.map(object => <ObjectCard key={object.href} object={object} />)}
          </div>
        ))}
        {pending && <p role="status" className="flex items-center gap-1.5 text-[13px] text-text-2"><span className="sr-only">正在回答</span>
          {[0, 1, 2].map(i => <span key={i} aria-hidden="true" className={`size-1.5 rounded-pill motion-safe:animate-breathe ${DOTS[i]}`} />)}
        </p>}
        <div ref={endRef} />
      </div>
      <form onSubmit={event => { event.preventDefault(); onSend(); }} className={`shrink-0 ${compact ? "border-t border-line p-3" : "px-4 pb-6"}`}>
        <div className={`rounded-card border border-line-strong bg-surface p-2 transition-[border-color,box-shadow] duration-(--duration-state) focus-within:border-text-3 ${compact ? "" : "shadow-card [view-transition-name:composer]"}`}>
          {contextLabel && <span className="mb-1 inline-flex h-6 max-w-full items-center truncate rounded-pill bg-surface-2 px-2 text-[12px] text-text-2">关于：{contextLabel}</span>}
          <div className="flex items-end gap-2">
            <label className="sr-only" htmlFor={inputId}>追问</label>
            <textarea id={inputId} rows={1} value={draft} onChange={event => onDraftChange(event.target.value)} onKeyDown={onKeyDown}
              placeholder="继续问" className="max-h-40 min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-[15px] leading-6 text-text placeholder:text-text-3 focus:outline-none" />
            <button type="submit" aria-label="发送" disabled={!draft.trim() || pending}
              className="grid size-10 shrink-0 place-items-center rounded-pill bg-ink text-on-ink transition-[opacity,transform] duration-(--duration-state) ease-spring enabled:active:scale-95 disabled:scale-90 disabled:opacity-35"><ArrowUp size={18} aria-hidden="true" /></button>
          </div>
        </div>
      </form>
    </div>
  );
}
