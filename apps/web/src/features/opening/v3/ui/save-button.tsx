"use client";
import { ui } from "@aistudy/ui";

export type SaveState = "idle" | "saving" | "saved" | "failed";

const LABEL: Record<SaveState, string> = { idle: "", saving: "保存中…", saved: "", failed: "保存失败，重试" };

/** 保存类次要动作：保存中 → 已保存（勾号描边出现）→ 失败可重试。成功只在服务端确认后显示。 */
export function SaveButton({ state, idleLabel, savedLabel, onSave }: { state: SaveState; idleLabel: string; savedLabel: string; onSave: () => void }) {
  return (
    <button type="button" onClick={onSave} disabled={state === "saving" || state === "saved"} aria-live="polite"
      className={`${ui.quiet} disabled:opacity-100 ${state === "failed" ? "text-danger" : ""} ${state === "saving" ? "text-text-3" : ""}`}>
      {state === "saved" && (
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" className="text-accent">
          <path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="24" className="motion-safe:animate-draw" />
        </svg>
      )}
      {state === "idle" ? idleLabel : state === "saved" ? savedLabel : LABEL[state]}
    </button>
  );
}

