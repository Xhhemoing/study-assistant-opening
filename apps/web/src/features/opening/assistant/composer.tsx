"use client";

import { LoaderCircle, Send } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { TutorMode } from "@aistudy/contracts";

const MODES: TutorMode[] = ["hint", "explain", "listen", "think_together"];

export type ComposerPrivacy = "saved" | "ephemeral";

export type ComposerSubmit = {
  text: string;
  mode: TutorMode;
  privacy: ComposerPrivacy;
  clientKey: string;
};

export type ComposerSubmitResult = { accepted: boolean };

type Props = {
  disabled?: boolean;
  pending?: boolean;
  privacy?: ComposerPrivacy;
  onPrivacyChange?: (privacy: ComposerPrivacy) => void;
  onCancel?: () => void;
  draft: string;
  intent?: {
    sourceIds: readonly string[];
    currentPage?: number | null;
    chunkId?: string | null;
  };
  onDraftChange: (value: string) => void;
  onSubmit: (input: ComposerSubmit) => void | Promise<void | ComposerSubmitResult>;
};

function newClientKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `ck-${crypto.randomUUID()}`;
  }
  return `ck-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** Fingerprint of one logical send. Retries of the same intent must reuse clientKey. */
export function logicalSendFingerprint(input: {
  text: string;
  mode: TutorMode;
  sourceIds?: readonly string[];
  currentPage?: number | null;
  chunkId?: string | null;
}): string {
  const sources = [...(input.sourceIds ?? [])].sort().join(",");
  const page = input.currentPage ?? "";
  const chunk = input.chunkId ?? "";
  return `${input.mode}\u0000${input.text.trim()}\u0000${sources}\u0000${page}\u0000${chunk}`;
}

/**
 * Keep the key while the unconfirmed intent is unchanged.
 * A new message or a successful send (fingerprint cleared) mints a new key.
 */
export function nextClientKey(state: {
  clientKey: string | null;
  fingerprint: string | null;
  nextFingerprint: string;
  mint?: () => string;
}): { clientKey: string; fingerprint: string } {
  const mint = state.mint ?? newClientKey;
  if (state.clientKey && state.fingerprint === state.nextFingerprint) {
    return { clientKey: state.clientKey, fingerprint: state.fingerprint };
  }
  return { clientKey: mint(), fingerprint: state.nextFingerprint };
}

export function Composer({
  disabled,
  pending,
  privacy = "saved",
  onPrivacyChange,
  onCancel,
  draft,
  intent,
  onDraftChange,
  onSubmit,
}: Props) {
  const [mode, setMode] = useState<TutorMode>("explain");
  const [sendKey, setSendKey] = useState<{ clientKey: string; fingerprint: string } | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || pending || disabled) return;
    const issued = nextClientKey({
      clientKey: sendKey?.clientKey ?? null,
      fingerprint: sendKey?.fingerprint ?? null,
      nextFingerprint: logicalSendFingerprint({
        text,
        mode,
        sourceIds: intent?.sourceIds,
        currentPage: intent?.currentPage,
        chunkId: intent?.chunkId,
      }),
    });
    setSendKey(issued);
    try {
      const result = await onSubmit({ text, mode, privacy, clientKey: issued.clientKey });
      if (result?.accepted === false) return;
      setSendKey(null);
    } catch {
      // Leave sendKey so a retry of this unconfirmed intent reuses clientKey.
    }
  }

  return (
    <form
      className="flex flex-col gap-2 border-t border-zinc-200 p-3"
      onSubmit={handleSubmit}
    >
      <label className="flex items-center gap-2 text-sm text-zinc-600">
        <span className="shrink-0">模式</span>
        <select
          className="rounded-md border border-zinc-300 bg-white px-2 py-1"
          value={mode}
          disabled={pending || disabled}
          onChange={(e) => setMode(e.target.value as TutorMode)}
          aria-label="辅导模式"
        >
          {MODES.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <span className="shrink-0">保存</span>
        <select
          className="rounded-md border border-zinc-300 bg-white px-2 py-1"
          value={privacy}
          disabled={pending || disabled}
          onChange={(e) => onPrivacyChange?.(e.target.value as ComposerPrivacy)}
          aria-label="隐私模式"
        >
          <option value="saved">保存对话</option>
          <option value="ephemeral">不保存本轮</option>
        </select>
      </label>
      <div className="flex gap-2">
        <textarea
          className="min-h-20 flex-1 resize-y rounded-md border border-zinc-300 px-3 py-2 text-sm"
          value={draft}
          disabled={pending || disabled}
          onChange={(e) => onDraftChange(e.target.value)}
          placeholder="自由交流，或基于已选材料提问…"
          aria-label="消息输入"
        />
        {pending && onCancel ? (
          <button
            type="button"
            className="self-end rounded-md border border-zinc-300 px-3 py-2 text-sm text-zinc-700"
            onClick={onCancel}
          >
            取消
          </button>
        ) : null}
        <button
          type="submit"
          className="inline-flex items-center gap-1 self-end rounded-md bg-zinc-900 px-3 py-2 text-sm text-white disabled:opacity-50"
          disabled={pending || disabled || draft.trim().length === 0}
          aria-label="发送"
        >
          {pending ? (
            <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Send className="h-4 w-4" aria-hidden />
          )}
          发送
        </button>
      </div>
    </form>
  );
}
