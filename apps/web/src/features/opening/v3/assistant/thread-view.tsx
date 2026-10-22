"use client";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ArrowDown, ArrowUp, FileText, PenLine, Square, X } from "lucide-react";
import { ui } from "@aistudy/ui";
import { TransitionLink } from "../motion/view-transition";
import { ThinkingLine } from "../motion/feedback";


export type ObjectRef = { kind: "problem" | "doc"; label: string; meta: string; href: string };
export type ThreadMessage = { id: string; role: "user" | "ai"; text: string; objects?: ObjectRef[]; status?: "streaming" | "stopped" | "failed" | "done" };
export type ThreadContext = { id: string; label: string };

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
  /** 服务端给出的进行中状态（如「正在查教材第 12 页」）；null 表示空闲 */
  thinking: string | null;
  draft: string;
  onDraftChange: (text: string) => void;
  onSend: () => void;
  onStop?: () => void;
  onRetry?: (message: ThreadMessage) => void;
  /** 回答渲染：生产传入仓库的 LearningProse + StreamText（公式、引用、逐段显现）；默认纯文本 */
  renderAnswer?: (message: ThreadMessage, compact: boolean) => ReactNode;
  compact?: boolean;
  /** 本次请求实际携带的上下文；可移除，移除后请求同步变化 */
  context?: ThreadContext[];
  onRemoveContext?: (id: string) => void;
  inputId: string;
  emptyHint?: ReactNode;
};

/**
 * 对话视图（纯问答与辅助区共用）。
 * - 只在接近底部或自己刚发送时跟随新内容；回看历史时出现「新回答」提示，不强制滚动。
 * - 进行中显示服务端状态行（流光 + 原地换字），可停止；失败或停止后可重试。
 * - 居中模式输入框与开始页共享 view-transition-name，从中央落到底部。
 */
export function ThreadView({ messages, thinking, draft, onDraftChange, onSend, onStop, onRetry, renderAnswer, compact = false, context = [], onRemoveContext, inputId, emptyHint }: ThreadViewProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const sentByMe = useRef(false);
  const [unseen, setUnseen] = useState(false);
  const last = messages[messages.length - 1];
  const busy = thinking !== null || last?.status === "streaming";

  const toBottom = (smooth = true) => scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  useLayoutEffect(() => { toBottom(false); }, []);
  useEffect(() => {
    if (nearBottom.current || sentByMe.current) { toBottom(); setUnseen(false); }
    else setUnseen(true);
    sentByMe.current = false;
  }, [messages.length, last?.text, thinking]);

  function send() { if (!draft.trim() || busy) return; sentByMe.current = true; onSend(); }
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    send();
  }

  return (
    <div className={`relative flex h-full flex-col ${compact ? "" : "mx-auto w-full max-w-[720px]"}`}>
      <div ref={scroller} onScroll={event => { const el = event.currentTarget; nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; if (nearBottom.current) setUnseen(false); }}
        className={`min-h-0 flex-1 space-y-5 overflow-y-auto ${compact ? "p-4" : "px-4 py-8"}`}>
        {messages.length === 0 && emptyHint}
        {messages.map(message => message.role === "user" ? (
          <div key={message.id} className="ml-auto w-fit max-w-[85%] rounded-card bg-surface-2 px-4 py-2.5 text-[15px] leading-7 text-text motion-safe:animate-text-in">{message.text}</div>
        ) : (
          <div key={message.id} className="space-y-3 motion-safe:animate-text-in">
            {renderAnswer ? renderAnswer(message, compact) : <p className={`leading-7 text-text ${compact ? "text-[15px]" : "prose-reading"}`}>{message.text}</p>}
            {message.objects?.map(object => <ObjectCard key={object.href} object={object} />)}
            {(message.status === "failed" || message.status === "stopped") && onRetry && (
              <p className="flex items-center gap-2 text-[13px] text-text-2">{message.status === "failed" ? "回答中断了" : "已停止"}<button type="button" className={`${ui.quiet} min-h-9`} onClick={() => onRetry(message)}>重新回答</button></p>
            )}
          </div>
        ))}
        {thinking && <p className="text-[13px]"><ThinkingLine label={thinking} /></p>}
      </div>

      {unseen && (
        <button type="button" onClick={() => { toBottom(); setUnseen(false); }} className="absolute bottom-24 left-1/2 inline-flex min-h-9 -translate-x-1/2 items-center gap-1 rounded-pill bg-ink px-3 text-[13px] text-on-ink shadow-float motion-safe:animate-badge-pop">
          <ArrowDown size={14} aria-hidden="true" />新回答
        </button>
      )}

      <form onSubmit={event => { event.preventDefault(); send(); }} className={`shrink-0 ${compact ? "border-t border-line p-3" : "px-4 pb-6"}`}>
        <div className={`rounded-card border border-line-strong bg-surface p-2 transition-[border-color,box-shadow] duration-(--duration-state) focus-within:border-text-3 ${compact ? "" : "shadow-card [view-transition-name:composer]"}`}>
          {context.length > 0 && <div className="mb-1 flex flex-wrap gap-1">{context.map(chip => (
            <span key={chip.id} className="inline-flex h-7 max-w-full items-center gap-0.5 rounded-pill bg-surface-2 pl-2.5 text-[12px] text-text-2 motion-safe:animate-pop">
              <span className="truncate">{chip.label}</span>
              {onRemoveContext && <button type="button" aria-label={`不带上 ${chip.label}`} onClick={() => onRemoveContext(chip.id)} className="grid size-7 place-items-center"><X size={12} aria-hidden="true" /></button>}
            </span>
          ))}</div>}
          <div className="flex items-end gap-2">
            <label className="sr-only" htmlFor={inputId}>追问</label>
            <textarea id={inputId} rows={1} value={draft} onChange={event => onDraftChange(event.target.value)} onKeyDown={onKeyDown}
              placeholder="继续问" className="max-h-40 min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-[15px] leading-6 text-text placeholder:text-text-3 focus:outline-none" />
            {busy && onStop
              ? <button type="button" aria-label="停止回答" onClick={onStop} className="grid size-10 shrink-0 place-items-center rounded-pill border border-line-strong text-text motion-safe:animate-pop"><Square size={14} aria-hidden="true" className="fill-current" /></button>
              : <button type="submit" aria-label="发送" disabled={!draft.trim() || busy}
                  className="grid size-10 shrink-0 place-items-center rounded-pill bg-ink text-on-ink transition-[opacity,transform] duration-(--duration-enter) ease-bounce enabled:active:scale-95 disabled:scale-90 disabled:opacity-35"><ArrowUp size={18} aria-hidden="true" /></button>}
          </div>
        </div>
      </form>
    </div>
  );
}
