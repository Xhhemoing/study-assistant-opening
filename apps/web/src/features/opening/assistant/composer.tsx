"use client";

import { ArrowUp, LoaderCircle, LockKeyhole, Paperclip, Square } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import type { TutorMode } from "@aistudy/contracts";
import { secondaryButtonClass } from "../design/ui";

const MODES: { value: TutorMode; label: string }[] = [
  { value: "hint", label: "给我一点提示" }, { value: "explain", label: "帮我讲清楚" },
  { value: "listen", label: "听我讲一遍" }, { value: "think_together", label: "一起想一想" },
];
export type ComposerPrivacy = "saved" | "ephemeral";
export type ComposerSubmit = { text: string; mode: TutorMode; privacy: ComposerPrivacy; clientKey: string };
export type ComposerSubmitResult = { accepted: boolean };
type Props = {
  practiceMode?: boolean; disabled?: boolean; pending?: boolean; privacy?: ComposerPrivacy;
  onPrivacyChange?: (privacy: ComposerPrivacy) => void; onCancel?: () => void;
  onContext?: () => void; contextLabel?: string; draft: string;
  intent?: { sourceIds: readonly string[]; currentPage?: number | null; chunkId?: string | null };
  onDraftChange: (value: string) => void;
  onSubmit: (input: ComposerSubmit) => void | Promise<void | ComposerSubmitResult>;
};
function newClientKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? `ck-${crypto.randomUUID()}` : `ck-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
/** Retries of an unchanged logical send reuse the original client key. */
export function logicalSendFingerprint(input: {
  text: string; mode: TutorMode; sourceIds?: readonly string[]; currentPage?: number | null; chunkId?: string | null;
}): string {
  return `${input.mode}\u0000${input.text.trim()}\u0000${[...(input.sourceIds ?? [])].sort().join(",")}\u0000${input.currentPage ?? ""}\u0000${input.chunkId ?? ""}`;
}
export function nextClientKey(state: {
  clientKey: string | null; fingerprint: string | null; nextFingerprint: string; mint?: () => string;
}): { clientKey: string; fingerprint: string } {
  if (state.clientKey && state.fingerprint === state.nextFingerprint) return { clientKey: state.clientKey, fingerprint: state.fingerprint };
  return { clientKey: (state.mint ?? newClientKey)(), fingerprint: state.nextFingerprint };
}
export function shouldSubmitShortcut(event: { key: string; ctrlKey: boolean; metaKey: boolean; isComposing: boolean }): boolean {
  return (event.ctrlKey || event.metaKey) && event.key === "Enter" && !event.isComposing;
}
export function Composer({ practiceMode = false, disabled, pending, privacy = "saved", onPrivacyChange,
  onCancel, onContext, contextLabel, draft, intent, onDraftChange, onSubmit }: Props) {
  const [selectedMode, setMode] = useState<TutorMode>("explain");
  const [sending, setSending] = useState(false);
  const modes = practiceMode ? MODES.filter((item) => item.value === "hint" || item.value === "explain") : MODES;
  const mode = modes.some((item) => item.value === selectedMode) ? selectedMode : "explain";
  const effectivePrivacy = practiceMode ? "saved" : privacy;
  const sendKey = useRef<{ clientKey: string; fingerprint: string } | null>(null);
  const locked = useRef(false), composing = useRef(false), form = useRef<HTMLFormElement>(null);
  const blocked = Boolean(pending || disabled || sending);
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || blocked || locked.current || composing.current) return;
    locked.current = true; setSending(true);
    const issued = nextClientKey({ clientKey: sendKey.current?.clientKey ?? null, fingerprint: sendKey.current?.fingerprint ?? null,
      nextFingerprint: logicalSendFingerprint({ text, mode, ...intent }) });
    sendKey.current = issued;
    try {
      const result = await onSubmit({ text, mode, privacy: effectivePrivacy, clientKey: issued.clientKey });
      if (result?.accepted !== false) sendKey.current = null;
    } catch {
      // The parent shows the error; retain this intent's idempotency key.
    } finally { locked.current = false; setSending(false); }
  }
  return <form ref={form} className="shrink-0 bg-white px-4 pb-3 pt-2 sm:px-5" onSubmit={handleSubmit}>
    <div className="rounded-lg border border-zinc-300 bg-white transition-colors duration-150 focus-within:border-emerald-700 motion-reduce:transition-none">
      <textarea className="max-h-40 min-h-20 w-full resize-y rounded-t-lg border-0 bg-transparent px-3 py-3 text-base leading-7 text-zinc-800 outline-none placeholder:text-zinc-500 disabled:opacity-60 md:text-sm"
        value={draft} disabled={blocked} onChange={(event) => onDraftChange(event.target.value)}
        onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={(event) => { if (shouldSubmitShortcut({ key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey, isComposing: event.nativeEvent.isComposing || composing.current })) { event.preventDefault(); form.current?.requestSubmit(); } }}
        placeholder="自由交流，或基于已选材料提问…" aria-label="消息输入" />
      <div className="flex flex-wrap items-center justify-between gap-2 px-2 pb-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          {onContext ? <button type="button" className={secondaryButtonClass} aria-label="选择参考材料" title={contextLabel} onClick={onContext}><Paperclip size={14} aria-hidden /></button> : null}
          <select className="min-h-10 max-w-40 rounded-md bg-zinc-50 px-2 text-xs text-zinc-700 focus-visible:ring-2 focus-visible:ring-emerald-700 disabled:opacity-50 md:min-h-8" value={mode} disabled={blocked} onChange={(event) => setMode(event.target.value as TutorMode)} aria-label="辅导模式">
            {modes.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
          <label className="flex items-center gap-1 text-zinc-500"><LockKeyhole size={12} aria-hidden />
            <select className="min-h-10 max-w-28 rounded bg-transparent px-1 text-xs focus-visible:ring-2 focus-visible:ring-emerald-700 disabled:opacity-60 md:min-h-8" value={effectivePrivacy} disabled={practiceMode || blocked || !onPrivacyChange} onChange={(event) => onPrivacyChange?.(event.target.value as ComposerPrivacy)} aria-label="隐私模式">
              <option value="saved">保存对话</option>{!practiceMode ? <option value="ephemeral">不保存本轮</option> : null}
            </select>
          </label>
        </div>
        <div className="flex items-center gap-1">
          {pending && onCancel ? <button type="button" className={secondaryButtonClass} onClick={onCancel}><Square size={12} aria-hidden />取消</button> : null}
          <button type="submit" className="inline-flex size-10 shrink-0 items-center justify-center rounded-md bg-zinc-900 text-white transition-colors duration-150 hover:bg-zinc-700 focus-visible:ring-2 focus-visible:ring-emerald-700 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-400 motion-reduce:transition-none md:size-8" disabled={blocked || !draft.trim()} aria-label="发送" title="发送 · Ctrl / ⌘ + Enter">
            {blocked ? <LoaderCircle size={16} className="motion-safe:animate-spin" aria-hidden /> : <ArrowUp size={17} aria-hidden />}
          </button>
        </div>
      </div>
    </div>
    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] leading-4 text-zinc-500">
      <span>{practiceMode ? "练习辅导会保存对话并记录帮助。" : effectivePrivacy === "ephemeral" ? "本轮仅保留在当前标签页；刷新后不会恢复。" : contextLabel ?? "AI 可能出错，请核对原始材料。"}</span>
      <span className="hidden sm:inline">Ctrl / ⌘ + Enter 发送</span>
    </div>
  </form>;
}
