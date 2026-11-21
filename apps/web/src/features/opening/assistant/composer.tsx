"use client";

import { ArrowUp, LockKeyhole, Paperclip, Square, X } from "lucide-react";
import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { isSystemQueryPurpose, type ComposerPurpose, type QueryHistory, type TutorMode } from "@aistudy/contracts";
import { inferComposerIntent } from "@aistudy/domain";
import { secondaryButtonClass } from "../design/ui";

const MODE_LABELS: Record<TutorMode, string> = { hint: "只给提示", explain: "展开讲解", listen: "听我讲一遍", think_together: "一起想一想" };
const PURPOSE_LABELS: Partial<Record<ComposerPurpose, string>> = { teach: "带我学习", plan: "准备计划", query: "查学习记录", explain_state: "解释学习状态" };
type IntentOverride = { mode?: TutorMode; purpose?: ComposerPurpose };
export type ComposerPrivacy = "saved" | "ephemeral";
export type ComposerSubmit = { text: string; mode?: TutorMode; privacy: ComposerPrivacy; clientKey: string; querySystem?: boolean; purpose?: ComposerPurpose };
export type ComposerSubmitResult = { accepted: boolean; retryNotSent?: true };
type Props = {
  questionMode?: boolean; startMode?: boolean; attachments?: ReactNode; sendDisabled?: boolean; emptyText?: string;
  contextChips?: { id: string; label: string }[]; onRemoveContext?: (id: string) => void;
  compact?: boolean; practiceMode?: boolean; defaultMode?: TutorMode; disabled?: boolean; pending?: boolean; privacy?: ComposerPrivacy;
  queryAvailable?: boolean; contextBlocked?: boolean;
  history?: QueryHistory;
  onPrivacyChange?: (privacy: ComposerPrivacy) => void; onCancel?: () => void;
  onContext?: () => void; contextLabel?: string; draft: string;
  draftId?: string;
  intent?: { sourceSelection?: "auto" | "selected" | "none"; sourceIds: readonly string[]; currentPage?: number | null; chunkId?: string | null };
  /** Explicit, reversible choices; ordinary requests leave routing to the server. */
  modePrefill?: { mode: TutorMode; nonce: number } | null;
  purposePrefill?: { purpose: ComposerPurpose; nonce: number } | null;
  onClearIntentOverride?: () => void;
  onDraftChange: (value: string) => void;
  onSubmit: (input: ComposerSubmit) => void | Promise<void | ComposerSubmitResult>;
};
function newClientKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? `ck-${crypto.randomUUID()}` : `ck-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
/** Retries of an unchanged logical send reuse the original client key. */
export function logicalSendFingerprint(input: {
  text: string; mode?: TutorMode; privacy?: ComposerPrivacy; sourceSelection?: "auto" | "selected" | "none"; sourceIds?: readonly string[]; currentPage?: number | null; chunkId?: string | null; querySystem?: boolean; purpose?: ComposerPurpose;
}): string {
  return `${input.privacy ? `${input.privacy}\u0000` : ""}${input.sourceSelection ? `${input.sourceSelection}\u0000` : ""}${input.purpose ? `${input.purpose}\u0000` : ""}${input.querySystem ? "query\u0000" : ""}${input.mode ?? "auto"}\u0000${input.text.trim()}\u0000${[...(input.sourceIds ?? [])].sort().join(",")}\u0000${input.currentPage ?? ""}\u0000${input.chunkId ?? ""}`;
}
export function nextClientKey(state: {
  clientKey: string | null; fingerprint: string | null; nextFingerprint: string; mint?: () => string;
}): { clientKey: string; fingerprint: string } {
  if (state.clientKey && state.fingerprint === state.nextFingerprint) return { clientKey: state.clientKey, fingerprint: state.fingerprint };
  return { clientKey: (state.mint ?? newClientKey)(), fingerprint: state.nextFingerprint };
}
export function shouldSubmitShortcut(event: { key: string; ctrlKey: boolean; metaKey: boolean; isComposing: boolean; keyCode?: number; shiftKey?: boolean }, questionMode = false): boolean {
  return event.key === "Enter" && !event.isComposing && event.keyCode !== 229
    && (questionMode ? !event.shiftKey : event.ctrlKey || event.metaKey);
}
export function Composer({ compact = false, practiceMode = false, questionMode = false, startMode = false, attachments, sendDisabled, emptyText, contextChips = [], onRemoveContext, defaultMode, disabled, pending, privacy = "saved", onPrivacyChange,
  onCancel, onContext, contextLabel, draft, draftId, intent, modePrefill = null, purposePrefill = null, onClearIntentOverride, onDraftChange, onSubmit, queryAvailable = false, contextBlocked = false, history }: Props) {
  const [override, setOverride] = useState<IntentOverride>({});
  const effectivePrivacy = practiceMode ? "saved" : privacy;
  const lastPrivacy = useRef(effectivePrivacy);
  if (lastPrivacy.current !== effectivePrivacy) {
    lastPrivacy.current = effectivePrivacy;
    setOverride({});
  }
  const lastPurposePrefill = useRef<number | null>(null);
  if (purposePrefill && purposePrefill.nonce !== lastPurposePrefill.current) {
    lastPurposePrefill.current = purposePrefill.nonce;
    if (!isSystemQueryPurpose({ purpose: purposePrefill.purpose }) || queryAvailable) setOverride(current => ({ ...current, purpose: purposePrefill.purpose }));
  }
  const lastPrefill = useRef<number | null>(null);
  if (modePrefill && modePrefill.nonce !== lastPrefill.current) {
    lastPrefill.current = modePrefill.nonce;
    if (!practiceMode || modePrefill.mode === "hint" || modePrefill.mode === "explain") {
      setOverride(current => ({ ...current, mode: modePrefill.mode }));
    }
  }
  const [sending, setSending] = useState(false);
  const { querySystem } = inferComposerIntent({ text: draft, ...override, defaultMode, practiceMode, history });
  const sendKey = useRef<{ clientKey: string; fingerprint: string } | null>(null);
  const locked = useRef(false), composing = useRef(false), form = useRef<HTMLFormElement>(null);
  const blocked = Boolean(pending || disabled || sending);
  const sendBlocked = blocked || sendDisabled || (contextBlocked && !querySystem) || (querySystem && !queryAvailable);
  const overrideLabel = [override.purpose ? PURPOSE_LABELS[override.purpose] : null,
    override.mode && !isSystemQueryPurpose({ purpose: override.purpose }) ? MODE_LABELS[override.mode] : null].filter(Boolean).join(" · ") || "回答问题";
  function clearOverride() { setOverride({}); onClearIntentOverride?.(); }
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim() || emptyText;
    if (!text || sendBlocked || locked.current || composing.current) return;
    locked.current = true; setSending(true);
    const issued = nextClientKey({ clientKey: sendKey.current?.clientKey ?? null, fingerprint: sendKey.current?.fingerprint ?? null,
      nextFingerprint: logicalSendFingerprint({ text, privacy: effectivePrivacy, ...intent, ...override }) });
    sendKey.current = issued;
    try {
      const result = await onSubmit({ text, ...override, privacy: effectivePrivacy, clientKey: issued.clientKey });
      if (result?.accepted !== false) { sendKey.current = null; clearOverride(); }
      else if (effectivePrivacy === "ephemeral" && result.retryNotSent && sendKey.current === issued) {
        // No automatic resend: the next explicit click creates the new key.
        // Preserve both the draft and the one-turn choices.
        sendKey.current = null;
      }
    } catch {
      // The parent shows the error; retain this intent's idempotency key.
    } finally { locked.current = false; setSending(false); }
  }
  return <form ref={form} aria-busy={Boolean(pending || sending)} className={`shrink-0 rounded-panel glass [--glass-bg:var(--glass-bg-strong)] p-2.5 sm:p-3 ${startMode ? "" : "mx-2 mb-2 sm:mx-4 sm:mb-3"}`} onSubmit={handleSubmit}>
    <div className="mb-1.5 flex min-h-8 flex-wrap items-center justify-between gap-x-3 gap-y-1 px-1 text-xs text-text-2">
      {onPrivacyChange && !practiceMode ? <details>
        <summary className="flex min-h-8 cursor-pointer items-center gap-1.5 rounded-md px-1.5 transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"><LockKeyhole size={13} aria-hidden />{effectivePrivacy === "saved" ? "保存对话" : "临时对话"}<span className="text-text-3">· 更改</span></summary>
        <label className="flex items-center gap-2 py-1">对话保存方式<select className="min-h-9 rounded-lg border border-line-strong bg-surface px-2.5 text-xs text-text [box-shadow:var(--field-shadow)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60" value={effectivePrivacy} disabled={blocked} onChange={event => onPrivacyChange(event.target.value as ComposerPrivacy)} aria-label="隐私模式"><option value="saved">保存对话</option><option value="ephemeral">临时对话</option></select></label>
      </details> : <span className="inline-flex min-h-8 items-center gap-1.5 px-1"><LockKeyhole size={13} aria-hidden />{effectivePrivacy === "saved" ? "保存对话" : "临时对话"}</span>}
      {override.mode || override.purpose ? <span className="inline-flex min-h-8 items-center gap-1 rounded-full border border-line bg-surface-2 pl-2.5"><span>{overrideLabel}</span><button type="button" className="inline-flex size-8 items-center justify-center rounded-full hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50" disabled={blocked} onClick={clearOverride} aria-label="撤回本轮选择，恢复自动判断" title="撤回本轮选择"><X size={13} aria-hidden /></button></span> : null}
    </div>
    <div className="overflow-hidden rounded-[var(--radius-ctl,12px)] border border-line-strong bg-surface [box-shadow:var(--field-shadow)] transition-[border-color,box-shadow] duration-150 ease-out-strong focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/25 motion-reduce:transition-none">
      <textarea id={draftId} className={`max-h-40 ${compact ? "min-h-16" : "min-h-20"} w-full resize-y border-0 bg-transparent px-3.5 py-2.5 text-base leading-7 text-text outline-none placeholder:text-text-3 disabled:opacity-60 md:text-sm`}
        value={draft} disabled={blocked} onChange={(event) => onDraftChange(event.target.value)}
        onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={(event) => { if (shouldSubmitShortcut({ key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey, keyCode: event.keyCode, isComposing: event.nativeEvent.isComposing || composing.current }, questionMode)) { event.preventDefault(); form.current?.requestSubmit(); } }}
        placeholder={startMode ? "问一道题、一个概念，或说说你的考试安排" : "自由交流，或基于已选材料提问…"} aria-label="消息输入" />
      {contextChips.length ? <ul aria-label="提问上下文" className="flex flex-wrap gap-1.5 px-3 pb-2">
        {contextChips.map(chip => <li key={chip.id} className="inline-flex min-h-8 max-w-full items-center gap-1 rounded-full border border-line bg-surface-2 pl-2.5 text-xs text-text-2"><span className="break-words">{chip.label}</span>{onRemoveContext ? <button type="button" disabled={blocked} aria-label={`不使用 ${chip.label}`} className="grid size-8 shrink-0 place-items-center rounded-full hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring" onClick={() => onRemoveContext(chip.id)}><X size={13} aria-hidden="true" /></button> : null}</li>)}
      </ul> : null}
      <div aria-label="消息操作" className="flex items-center justify-between gap-2 border-t border-line bg-surface-2/35 px-2.5 py-1.5">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {attachments}
          {onContext ? <button type="button" className={secondaryButtonClass} aria-label="选择参考材料" title={contextLabel} disabled={blocked} onClick={onContext}><Paperclip size={14} aria-hidden /></button> : null}
        </div>
        <div className="flex items-center gap-1.5">
          {pending && onCancel ? <button type="button" className="keycap-ink inline-flex size-10 pointer-coarse:size-11 items-center justify-center rounded-xl transition-[background-color,box-shadow,transform] duration-150 ease-out-strong active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 motion-reduce:transition-none" onClick={onCancel} aria-label="停止回答" title="停止回答"><Square size={15} aria-hidden="true" /></button> : <button type="submit" className="keycap-ink inline-flex size-10 pointer-coarse:size-11 shrink-0 items-center justify-center rounded-xl transition-[background-color,box-shadow,transform] duration-150 ease-out-strong hover:bg-ink/92 active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 disabled:pointer-events-none disabled:border-line disabled:bg-surface-2 disabled:text-text-3 disabled:[box-shadow:none] motion-reduce:transition-none" disabled={sendBlocked || (!draft.trim() && !emptyText)} aria-label="发送" title={questionMode ? "发送 · Enter（Shift + Enter 换行）" : "发送 · Ctrl / ⌘ + Enter"}>
            <ArrowUp size={17} aria-hidden="true" />
          </button>}
        </div>
      </div>
    </div>
    {querySystem || practiceMode || effectivePrivacy === "ephemeral" ? <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 px-1 text-xs leading-5 text-text-2">
      {practiceMode ? <span>练习辅导会保存对话并记录帮助。</span> : null}
      {querySystem ? <span>{queryAvailable ? "查询你的学习记录。" : "学习记录暂时不可查询，可以继续编辑问题。"}</span>
        : !practiceMode && effectivePrivacy === "ephemeral" ? <span>本轮仅保留在当前标签页；刷新后不会恢复。</span> : null}
    </div> : null}
  </form>;
}
