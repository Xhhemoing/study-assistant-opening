"use client";
import { ui } from "./controls";
import { SuccessCheck, TextSwap } from "../motion/feedback";

/** 保存状态：本机草稿、已提交服务端、保存失败要分开表达，只有服务端确认后才显示「已保存」。 */
export type SaveState = "idle" | "saving" | "saved" | "failed";

/** 保存类次要动作：文字原地换字；成功时勾号进入；失败保留重试。 */
export function SaveButton({ state, idleLabel, savedLabel, onSave }: { state: SaveState; idleLabel: string; savedLabel: string; onSave: () => void }) {
  const label = state === "idle" ? idleLabel : state === "saved" ? savedLabel : state === "saving" ? "保存中…" : "保存失败，重试";
  return (
    <button type="button" onClick={onSave} disabled={state === "saving" || state === "saved"} aria-live="polite"
      className={`${ui.quiet} disabled:opacity-100 ${state === "failed" ? "text-danger" : ""} ${state === "saving" ? "text-text-3" : ""}`}>
      {state === "saved" && <SuccessCheck play size={14} label="" />}
      <TextSwap value={label} />
    </button>
  );
}
