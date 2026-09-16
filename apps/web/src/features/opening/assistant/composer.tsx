"use client";

import { LoaderCircle, Send } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { TutorMode } from "@aistudy/contracts";

const MODES: TutorMode[] = ["hint", "explain", "listen", "think_together"];

export type ComposerSubmit = {
  text: string;
  mode: TutorMode;
  clientKey: string;
};

type Props = {
  disabled?: boolean;
  pending?: boolean;
  draft: string;
  onDraftChange: (value: string) => void;
  onSubmit: (input: ComposerSubmit) => void | Promise<void>;
};

function newClientKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `ck-${crypto.randomUUID()}`;
  }
  return `ck-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function Composer({
  disabled,
  pending,
  draft,
  onDraftChange,
  onSubmit,
}: Props) {
  const [mode, setMode] = useState<TutorMode>("explain");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || pending || disabled) return;
    await onSubmit({ text, mode, clientKey: newClientKey() });
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
      </label>
      <div className="flex gap-2">
        <textarea
          className="min-h-20 flex-1 resize-y rounded-md border border-zinc-300 px-3 py-2 text-sm"
          value={draft}
          disabled={pending || disabled}
          onChange={(e) => onDraftChange(e.target.value)}
          placeholder="基于已选材料提问…"
          aria-label="消息输入"
        />
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
