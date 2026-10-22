"use client";
import { useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ArrowUp, Camera, Paperclip, X } from "lucide-react";
import { TransitionLink } from "../motion/view-transition";
import { motion } from "../motion";
import { NAV_TOOLS, featureHref } from "../shell/features";

export type ContextChip = { id: string; label: string };
/** 第一条为首选行动：给一句理由和预计时间（来自真实计划，不由模型临时推断） */
export type Suggestion = { id: string; label: string; meta?: string; reason?: string; minutes?: number; href: string };

type StartComposerProps = {
  greeting: string;
  /** 由已有记录直接计算（继续位置、到期数、考期），不等模型；没有就传空数组 */
  suggestions: Suggestion[];
  examples?: string[];
  context: ContextChip[];
  onRemoveContext: (id: string) => void;
  onSubmit: (text: string, files: File[]) => void;
  draft: string;
  onDraftChange: (text: string) => void;
};

/**
 * T2 开始页。动效：问候与输入框依次浮现，建议错开出现；发送按钮可用时放大到位；
 * 输入框带 view-transition-name，进入对话后与底部输入框共享过渡（从中央落到底部）。
 */
export function StartComposer({ greeting, suggestions, examples = [], context, onRemoveContext, onSubmit, draft, onDraftChange }: StartComposerProps) {
  const [files, setFiles] = useState<File[]>([]);
  const cameraRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const canSend = Boolean(draft.trim()) || files.length > 0;

  function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!canSend) return;
    onSubmit(draft.trim(), files);
    setFiles([]);
  }
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    submit();
  }
  const addFiles = (list: FileList | null) => list && setFiles(current => [...current, ...Array.from(list)]);
  const tool = `inline-flex h-9 items-center gap-1.5 rounded-md px-2.5 text-[13px] text-text-2 hover:bg-surface-2 hover:text-text ${motion.colors}`;

  return (
    <div className={`mx-auto flex min-h-full w-full max-w-[720px] flex-col justify-center gap-5 px-4 py-10 ${motion.stagger}`}>
      <h1 className="sr-only">开始</h1>
      <p className="text-[15px] text-text-2">{greeting}</p>

      <form onSubmit={submit} className="rounded-card border border-line-strong bg-surface p-3 shadow-card transition-[border-color,box-shadow] duration-(--duration-state) [view-transition-name:composer] focus-within:border-text-3 focus-within:shadow-float">
        <label htmlFor="start-input" className="sr-only">提问</label>
        <textarea id="start-input" value={draft} onChange={event => onDraftChange(event.target.value)} onKeyDown={onKeyDown}
          rows={2} placeholder="问一道题、一个概念，或说说你的考试安排"
          className="block w-full resize-none bg-transparent text-[16px] leading-7 text-text placeholder:text-text-3 focus:outline-none" />
        {files.length > 0 && <ul className="mt-2 flex flex-wrap gap-2">{files.map((file, index) => (
          <li key={`${file.name}-${index}`} className="flex h-8 items-center gap-1 rounded-sm bg-surface-2 pl-2 text-[13px] text-text-2 motion-safe:animate-pop">
            {file.name}
            <button type="button" aria-label={`移除 ${file.name}`} onClick={() => setFiles(current => current.filter((_, i) => i !== index))} className="grid size-8 place-items-center"><X size={14} aria-hidden="true" /></button>
          </li>
        ))}</ul>}
        <div className="mt-2 flex flex-wrap items-center gap-1">
          <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={event => addFiles(event.target.files)} />
          <input ref={fileRef} type="file" multiple hidden onChange={event => addFiles(event.target.files)} />
          <button type="button" onClick={() => cameraRef.current?.click()} className={tool}><Camera size={16} aria-hidden="true" />拍题</button>
          <button type="button" onClick={() => fileRef.current?.click()} className={tool}><Paperclip size={16} aria-hidden="true" />上传</button>
          {context.map(chip => (
            <span key={chip.id} className="inline-flex h-7 items-center gap-1 rounded-pill bg-surface-2 pl-2.5 text-[12px] text-text-2">
              {chip.label}
              <button type="button" aria-label={`不使用 ${chip.label}`} onClick={() => onRemoveContext(chip.id)} className="grid size-7 place-items-center"><X size={12} aria-hidden="true" /></button>
            </span>
          ))}
          <button type="submit" aria-label="发送" disabled={!canSend}
            className="ml-auto grid size-10 place-items-center rounded-pill bg-ink text-on-ink transition-[opacity,transform] duration-(--duration-state) ease-spring enabled:active:scale-95 disabled:scale-90 disabled:opacity-35">
            <ArrowUp size={18} aria-hidden="true" />
          </button>
        </div>
      </form>

      {suggestions.length > 0 ? (
        <div className="space-y-1">
        {suggestions[0] && (
          <TransitionLink href={suggestions[0].href} direction="forward" vtSource="object-title"
            className="group flex items-center gap-3 rounded-card border border-line bg-surface px-4 py-3 shadow-card transition-[border-color,box-shadow,transform] duration-(--duration-micro) hover:border-line-strong hover:shadow-float active:scale-[0.995]">
            <span className="min-w-0 flex-1">
              <span className="block text-[12px] text-text-2">先做这个{suggestions[0].minutes ? ` · 约 ${suggestions[0].minutes} 分钟` : ""}</span>
              <span data-vt-title className="block truncate text-[16px] font-medium text-text">{suggestions[0].label}</span>
              {suggestions[0].reason ? <span className="block truncate text-[13px] text-text-2">{suggestions[0].reason}</span> : null}
            </span>
            <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-pill bg-ink text-on-ink transition-transform duration-(--duration-micro) group-hover:translate-x-0.5">→</span>
          </TransitionLink>
        )}
        <ul aria-label="其他继续" className={`divide-y divide-line ${motion.stagger}`}>
          {suggestions.slice(1, 3).map(item => (
            <li key={item.id}><TransitionLink href={item.href} className="group flex min-h-11 items-center justify-between gap-3 px-1 py-2 text-[15px] text-text-2 transition-colors hover:text-text">
              <span data-vt-title>{item.label}{item.meta ? <span className="ml-2 text-[13px] text-text-2">{item.meta}</span> : null}</span>
              <span aria-hidden="true" className="transition-transform duration-(--duration-micro) group-hover:translate-x-0.5">→</span>
            </TransitionLink></li>
          ))}
        </ul>
        </div>
      ) : examples.length > 0 ? (
        <ul aria-label="可以这样问" className={`flex flex-wrap gap-2 ${motion.stagger}`}>
          {examples.map(example => <li key={example}><button type="button" onClick={() => onDraftChange(example)} className={`min-h-9 rounded-pill border border-line px-3 text-[13px] text-text-2 hover:bg-surface-2 ${motion.press}`}>{example}</button></li>)}
        </ul>
      ) : <span />}

      <nav aria-label="学习工具" className="flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-text-2">
        {NAV_TOOLS.map(item => <TransitionLink key={item.id} href={item.route} className="py-1 hover:text-text">{item.id === "sprint" ? "考前冲刺" : item.label}</TransitionLink>)}
        <TransitionLink href={featureHref("course-new")} className="py-1 hover:text-text">新建课程</TransitionLink>
      </nav>
    </div>
  );
}
