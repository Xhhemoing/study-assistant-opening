"use client";

import { ArrowUp, LockKeyhole, Paperclip, Square } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { isSystemQueryPurpose, type ComposerPurpose, type TutorMode } from "@aistudy/contracts";
import { secondaryButtonClass } from "../design/ui";

const MODES: { value: TutorMode; label: string }[] = [
  { value: "hint", label: "给我一点提示" }, { value: "explain", label: "帮我讲清楚" },
  { value: "listen", label: "听我讲一遍" }, { value: "think_together", label: "一起想一想" },
];
export type ComposerPrivacy = "saved" | "ephemeral";
export type ComposerSubmit = { text: string; mode: TutorMode; privacy: ComposerPrivacy; clientKey: string; querySystem?: boolean; purpose?: ComposerPurpose };
export type ComposerSubmitResult = { accepted: boolean };
type Props = {
  compact?: boolean; practiceMode?: boolean; defaultMode?: TutorMode; disabled?: boolean; pending?: boolean; privacy?: ComposerPrivacy;
  queryAvailable?: boolean; contextBlocked?: boolean;
  onPrivacyChange?: (privacy: ComposerPrivacy) => void; onCancel?: () => void;
  onContext?: () => void; contextLabel?: string; draft: string;
  draftId?: string;
  intent?: { sourceSelection?: "auto" | "selected" | "none"; sourceIds: readonly string[]; currentPage?: number | null; chunkId?: string | null };
  /** Chip prefill: switches the selected mode once per nonce change. */
  modePrefill?: { mode: TutorMode; nonce: number } | null;
  purposePrefill?: { purpose: ComposerPurpose; nonce: number } | null;
  onDraftChange: (value: string) => void;
  onSubmit: (input: ComposerSubmit) => void | Promise<void | ComposerSubmitResult>;
};
function newClientKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? `ck-${crypto.randomUUID()}` : `ck-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
/** Retries of an unchanged logical send reuse the original client key. */
export function logicalSendFingerprint(input: {
  text: string; mode: TutorMode; sourceSelection?: "auto" | "selected" | "none"; sourceIds?: readonly string[]; currentPage?: number | null; chunkId?: string | null; querySystem?: boolean; purpose?: ComposerPurpose;
}): string {
  return `${input.sourceSelection ? `${input.sourceSelection}\u0000` : ""}${input.purpose ? `${input.purpose}\u0000` : ""}${input.querySystem ? "query\u0000" : ""}${input.mode}\u0000${input.text.trim()}\u0000${[...(input.sourceIds ?? [])].sort().join(",")}\u0000${input.currentPage ?? ""}\u0000${input.chunkId ?? ""}`;
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
export function Composer({ compact = false, practiceMode = false, defaultMode, disabled, pending, privacy = "saved", onPrivacyChange,
  onCancel, onContext, contextLabel, draft, draftId, intent, modePrefill = null, purposePrefill = null, onDraftChange, onSubmit, queryAvailable = false, contextBlocked = false }: Props) {
  const [purpose, setPurpose] = useState<ComposerPurpose>("answer");
  const lastPurposePrefill = useRef<number | null>(null);
  if (purposePrefill && purposePrefill.nonce !== lastPurposePrefill.current) {
    lastPurposePrefill.current = purposePrefill.nonce;
    if (!isSystemQueryPurpose({ purpose: purposePrefill.purpose }) || queryAvailable) setPurpose(purposePrefill.purpose);
  }
  const querySystem = queryAvailable && isSystemQueryPurpose({ purpose });
  const [selectedMode, setMode] = useState<TutorMode>(defaultMode ?? (practiceMode ? "hint" : "explain"));
  const lastPrefill = useRef<number | null>(null);
  if (modePrefill && modePrefill.nonce !== lastPrefill.current) {
    lastPrefill.current = modePrefill.nonce;
    if (!practiceMode || modePrefill.mode === "hint" || modePrefill.mode === "explain") {
      setMode(modePrefill.mode);
    }
  }
  const [sending, setSending] = useState(false);
  const modes = practiceMode ? MODES.filter((item) => item.value === "hint" || item.value === "explain") : MODES;
  const mode = modes.some((item) => item.value === selectedMode) ? selectedMode : "explain";
  const effectivePrivacy = practiceMode ? "saved" : privacy;
  const sendKey = useRef<{ clientKey: string; fingerprint: string } | null>(null);
  const locked = useRef(false), composing = useRef(false), form = useRef<HTMLFormElement>(null);
  const blocked = Boolean(pending || disabled || sending || (contextBlocked && !querySystem));
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || blocked || locked.current || composing.current) return;
    locked.current = true; setSending(true);
    const issued = nextClientKey({ clientKey: sendKey.current?.clientKey ?? null, fingerprint: sendKey.current?.fingerprint ?? null,
      nextFingerprint: logicalSendFingerprint({ text, mode, ...intent, querySystem, purpose }) });
    sendKey.current = issued;
    try {
      const result = await onSubmit({ text, mode, privacy: effectivePrivacy, clientKey: issued.clientKey, purpose, ...(querySystem ? { querySystem: true } : {}) });
      if (result?.accepted !== false) sendKey.current = null;
    } catch {
      // The parent shows the error; retain this intent's idempotency key.
    } finally { locked.current = false; setSending(false); }
  }
  return <form ref={form} aria-busy={Boolean(pending || sending)} className="shrink-0 border-t border-line/70 bg-surface px-3 py-2 sm:px-5" onSubmit={handleSubmit}>
    <div className="overflow-hidden rounded-xl border border-text-3 bg-surface shadow-sm shadow-zinc-900/5 transition-[border-color,box-shadow] duration-200 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent focus-within:ring-offset-2 focus-within:shadow-md focus-within:shadow-emerald-600/10 motion-reduce:transition-none">
      <textarea id={draftId} className="max-h-40 min-h-20 w-full resize-y border-0 bg-transparent px-4 py-2 text-base leading-7 text-text outline-none placeholder:text-text-3 disabled:opacity-60 md:text-sm"
        value={draft} disabled={blocked} onChange={(event) => onDraftChange(event.target.value)}
        onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={(event) => { if (shouldSubmitShortcut({ key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey, isComposing: event.nativeEvent.isComposing || composing.current })) { event.preventDefault(); form.current?.requestSubmit(); } }}
        placeholder="自由交流，或基于已选材料提问…" aria-label="消息输入" />
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line bg-bg/50 px-2 py-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <label className="inline-flex items-center gap-1.5 text-xs text-text-2"><span className={compact ? "sr-only" : ""}>本轮目的</span><select className="min-h-10 max-w-40 rounded-lg bg-surface px-2 text-xs ring-1 ring-line md:min-h-8" aria-label="本轮目的" value={purpose} disabled={Boolean(pending || disabled || sending)} onChange={event => setPurpose(event.target.value as ComposerPurpose)}><option value="answer">回答问题</option><option value="teach">带我学习</option><option value="plan">准备计划草稿</option>{queryAvailable ? <><option value="explain_state">解释学习状态</option><option value="query">查询系统记录</option></> : null}</select></label>
          {onContext ? <button type="button" className={secondaryButtonClass} aria-label="选择参考材料" title={contextLabel} onClick={onContext}><Paperclip size={14} aria-hidden /></button> : null}
          <details className="min-w-0 max-w-full">
            <summary className="flex min-h-10 cursor-pointer items-center rounded px-2 text-xs text-text focus-visible:ring-2 focus-visible:ring-emerald-600 md:min-h-8">{compact ? { hint: "提示", explain: "讲解", listen: "复述", think_together: "一起想" }[mode] : modes.find(item => item.value === mode)?.label} · {effectivePrivacy === "saved" ? (compact ? "保存" : "保存对话") : (compact ? "临时" : "临时对话")} · 设置</summary>
            <div className="flex flex-wrap items-center gap-2 py-2">
              <select className="min-h-10 max-w-40 rounded-lg bg-surface px-2.5 text-xs text-text shadow-xs ring-1 ring-zinc-900/5 transition-[box-shadow,ring] duration-150 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50 motion-reduce:transition-none md:min-h-8" value={mode} disabled={blocked} onChange={(event) => setMode(event.target.value as TutorMode)} aria-label="辅导模式">
                {modes.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
              <label className="flex items-center gap-1.5 text-text-2"><LockKeyhole size={13} aria-hidden />
                <select className="min-h-10 max-w-28 rounded-lg bg-transparent px-1.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60 motion-reduce:transition-none md:min-h-8" value={effectivePrivacy} disabled={practiceMode || blocked || !onPrivacyChange} onChange={(event) => onPrivacyChange?.(event.target.value as ComposerPrivacy)} aria-label="隐私模式">
                  <option value="saved">保存对话</option>{!practiceMode ? <option value="ephemeral">临时对话</option> : null}
                </select>
              </label>
            </div>
          </details>
        </div>
        <div className="flex items-center gap-1.5">
          {pending && onCancel ? <button type="button" className="inline-flex size-11 items-center justify-center rounded-xl bg-ink text-on-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2" onClick={onCancel} aria-label="停止回答" title="停止回答"><Square size={16} aria-hidden="true" /></button> : <button type="submit" className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl bg-ink text-on-ink shadow-md transition-transform duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 active:scale-95 disabled:pointer-events-none disabled:bg-surface-2 disabled:text-text-3 disabled:shadow-none motion-reduce:transition-none motion-reduce:active:scale-100" disabled={blocked || !draft.trim()} aria-label="发送" title="发送 · Ctrl / ⌘ + Enter">
            <ArrowUp size={18} aria-hidden="true" />
          </button>}
        </div>
      </div>
    </div>
    {querySystem || practiceMode || effectivePrivacy === "ephemeral" ? <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-xs leading-5 text-text-2">
      <span>{querySystem ? "查学习记录：使用固定规则，无需 AI 辅导额度。" : practiceMode ? "练习辅导会保存对话并记录帮助。" : "本轮仅保留在当前标签页；刷新后不会恢复。"}</span>
    </div> : null}
  </form>;
}
