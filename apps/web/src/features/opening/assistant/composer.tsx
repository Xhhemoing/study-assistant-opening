"use client";

import { ArrowUp, LockKeyhole, Paperclip, Square, X } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { isSystemQueryPurpose, type ComposerPurpose, type QueryHistory, type TutorMode } from "@aistudy/contracts";
import { inferComposerIntent } from "@aistudy/domain";
import { secondaryButtonClass } from "../design/ui";

const MODE_LABELS: Record<TutorMode, string> = { hint: "只给提示", explain: "展开讲解", listen: "听我讲一遍", think_together: "一起想一想" };
const PURPOSE_LABELS: Partial<Record<ComposerPurpose, string>> = { teach: "带我学习", plan: "准备计划", query: "查学习记录", explain_state: "解释学习状态" };
type IntentOverride = { mode?: TutorMode; purpose?: ComposerPurpose };
export type ComposerPrivacy = "saved" | "ephemeral";
export type ComposerSubmit = { text: string; mode?: TutorMode; privacy: ComposerPrivacy; clientKey: string; querySystem?: boolean; purpose?: ComposerPurpose };
export type ComposerSubmitResult = { accepted: boolean };
type Props = {
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
export function shouldSubmitShortcut(event: { key: string; ctrlKey: boolean; metaKey: boolean; isComposing: boolean }): boolean {
  return (event.ctrlKey || event.metaKey) && event.key === "Enter" && !event.isComposing;
}
export function Composer({ compact = false, practiceMode = false, defaultMode, disabled, pending, privacy = "saved", onPrivacyChange,
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
  const sendBlocked = blocked || (contextBlocked && !querySystem) || (querySystem && !queryAvailable);
  const overrideLabel = [override.purpose ? PURPOSE_LABELS[override.purpose] : null,
    override.mode && !isSystemQueryPurpose({ purpose: override.purpose }) ? MODE_LABELS[override.mode] : null].filter(Boolean).join(" · ") || "回答问题";
  function clearOverride() { setOverride({}); onClearIntentOverride?.(); }
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || sendBlocked || locked.current || composing.current) return;
    locked.current = true; setSending(true);
    const issued = nextClientKey({ clientKey: sendKey.current?.clientKey ?? null, fingerprint: sendKey.current?.fingerprint ?? null,
      nextFingerprint: logicalSendFingerprint({ text, privacy: effectivePrivacy, ...intent, ...override }) });
    sendKey.current = issued;
    try {
      const result = await onSubmit({ text, ...override, privacy: effectivePrivacy, clientKey: issued.clientKey });
      if (result?.accepted !== false) { sendKey.current = null; clearOverride(); }
    } catch {
      // The parent shows the error; retain this intent's idempotency key.
    } finally { locked.current = false; setSending(false); }
  }
  return <form ref={form} aria-busy={Boolean(pending || sending)} className="shrink-0 border-t border-line/70 bg-surface px-3 py-2 sm:px-5" onSubmit={handleSubmit}>
    <div className="mb-1 flex min-h-8 flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-text-2">
      {onPrivacyChange && !practiceMode ? <details>
        <summary className="flex min-h-8 cursor-pointer items-center gap-1.5 rounded px-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"><LockKeyhole size={13} aria-hidden />{effectivePrivacy === "saved" ? "保存对话" : "临时对话"}<span className="text-text-3">· 更改</span></summary>
        <label className="flex items-center gap-2 py-1">对话保存方式<select className="min-h-9 rounded-lg bg-surface px-2 text-xs text-text ring-1 ring-line focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60" value={effectivePrivacy} disabled={blocked} onChange={event => onPrivacyChange(event.target.value as ComposerPrivacy)} aria-label="隐私模式"><option value="saved">保存对话</option><option value="ephemeral">临时对话</option></select></label>
      </details> : <span className="inline-flex min-h-8 items-center gap-1.5"><LockKeyhole size={13} aria-hidden />{effectivePrivacy === "saved" ? "保存对话" : "临时对话"}</span>}
      {override.mode || override.purpose ? <span className="inline-flex min-h-8 items-center gap-1 rounded-full border border-line bg-surface-2 pl-2.5"><span>{overrideLabel}</span><button type="button" className="inline-flex size-8 items-center justify-center rounded-full hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50" disabled={blocked} onClick={clearOverride} aria-label="撤回本轮选择，恢复自动判断" title="撤回本轮选择"><X size={13} aria-hidden /></button></span> : null}
    </div>
    <div className="overflow-hidden rounded-xl border border-text-3 bg-surface shadow-sm shadow-zinc-900/5 transition-[border-color,box-shadow] duration-200 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent focus-within:ring-offset-2 focus-within:shadow-md focus-within:shadow-emerald-600/10 motion-reduce:transition-none">
      <textarea id={draftId} className={`max-h-40 ${compact ? "min-h-16" : "min-h-20"} w-full resize-y border-0 bg-transparent px-4 py-2 text-base leading-7 text-text outline-none placeholder:text-text-3 disabled:opacity-60 md:text-sm`}
        value={draft} disabled={blocked} onChange={(event) => onDraftChange(event.target.value)}
        onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={(event) => { if (shouldSubmitShortcut({ key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey, isComposing: event.nativeEvent.isComposing || composing.current })) { event.preventDefault(); form.current?.requestSubmit(); } }}
        placeholder="自由交流，或基于已选材料提问…" aria-label="消息输入" />
      <div aria-label="消息操作" className="flex items-center justify-between gap-2 border-t border-line bg-bg/50 px-2 py-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {onContext ? <button type="button" className={secondaryButtonClass} aria-label="选择参考材料" title={contextLabel} disabled={blocked} onClick={onContext}><Paperclip size={14} aria-hidden /></button> : null}
        </div>
        <div className="flex items-center gap-1.5">
          {pending && onCancel ? <button type="button" className="inline-flex size-11 items-center justify-center rounded-xl bg-ink text-on-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2" onClick={onCancel} aria-label="停止回答" title="停止回答"><Square size={16} aria-hidden="true" /></button> : <button type="submit" className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl bg-ink text-on-ink shadow-md transition-transform duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 active:scale-95 disabled:pointer-events-none disabled:bg-surface-2 disabled:text-text-3 disabled:shadow-none motion-reduce:transition-none motion-reduce:active:scale-100" disabled={sendBlocked || !draft.trim()} aria-label="发送" title="发送 · Ctrl / ⌘ + Enter">
            <ArrowUp size={18} aria-hidden="true" />
          </button>}
        </div>
      </div>
    </div>
    {querySystem || practiceMode || effectivePrivacy === "ephemeral" ? <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-xs leading-5 text-text-2">
      <span>{querySystem ? queryAvailable ? "查询你的学习记录。" : "学习记录暂时不可查询，可以继续编辑问题。" : practiceMode ? "练习辅导会保存对话并记录帮助。" : "本轮仅保留在当前标签页；刷新后不会恢复。"}</span>
    </div> : null}
  </form>;
}
