"use client";
import { Check, Copy, CornerDownRight, FilePlus2 } from "lucide-react";
import { useState } from "react";
import { secondaryButtonClass } from "../design/ui";
export function MessageActions({ text, onPrompt, onSave, missingProvenance = false }: {
  text: string; onPrompt?: (text: string) => void; onSave?: () => void; missingProvenance?: boolean;
}) {
  const [copied, setCopied] = useState(false), [error, setError] = useState("");
  async function copy() {
    try { await navigator.clipboard.writeText(text); setCopied(true); setError(""); }
    catch { setError("复制失败，请选中回答文字复制。"); }
  }
  return <div className="mt-3 flex flex-wrap items-center gap-2">
    <button className={secondaryButtonClass} type="button" onClick={() => void copy()}>{copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}{copied ? "已复制" : "复制"}</button>
    {onPrompt ? <button className={secondaryButtonClass} type="button" onClick={() => onPrompt("请用一个具体例子进一步解释刚才的内容。") }><CornerDownRight size={13} aria-hidden />举个例子</button> : null}
    {onSave || missingProvenance ? <button className={secondaryButtonClass} type="button" disabled={missingProvenance} onPointerDown={(event) => event.preventDefault()} onClick={onSave}><FilePlus2 size={13} aria-hidden />保存片段</button> : null}
    {missingProvenance ? <p className="w-full text-xs leading-5 text-amber-800">这条内容缺少可验证的来源上下文，无法保存为关联笔记。请重新提问后保存新的片段。</p> : null}
    {error ? <p role="status" className="text-xs text-red-700">{error}</p> : null}
  </div>;
}
