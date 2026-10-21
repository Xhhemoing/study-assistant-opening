"use client";
import { Check, Copy, CornerDownRight, FilePlus2, Layers2 } from "lucide-react";
import { useEffect, useState } from "react";
import { secondaryButtonClass } from "../design/ui";
export function MessageActions({ text, onPrompt, onSave, onCreateCard, missingProvenance = false, querySaveUnsupported = false }: {
  text: string; onPrompt?: (text: string) => void; onSave?: () => void; onCreateCard?: () => void; missingProvenance?: boolean; querySaveUnsupported?: boolean;
}) {
  const [copiedText, setCopiedText] = useState<string | null>(null), [error, setError] = useState("");
  const copied = copiedText === text;
  useEffect(() => {
    if (copiedText === null) return;
    const timer = window.setTimeout(() => setCopiedText(null), 2_000);
    return () => window.clearTimeout(timer);
  }, [copiedText]);
  async function copy() {
    try { await navigator.clipboard.writeText(text); setCopiedText(text); setError(""); }
    catch { setError("复制失败，请选中回答文字复制。"); }
  }
  return <div className="mt-3 flex flex-wrap items-center gap-2">
    <span className="sr-only" role="status">{copied ? "回答已复制" : ""}</span>
    <button className={secondaryButtonClass} type="button" onClick={() => void copy()}>{copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}{copied ? "已复制" : "复制"}</button>
    {onPrompt ? <button className={secondaryButtonClass} type="button" onClick={() => onPrompt("请用一个具体例子进一步解释刚才的内容。") }><CornerDownRight size={13} aria-hidden />举个例子</button> : null}
    {onSave || missingProvenance || querySaveUnsupported ? <button className={secondaryButtonClass} type="button" disabled={missingProvenance || querySaveUnsupported || !onSave} onPointerDown={(event) => event.preventDefault()} onClick={onSave}><FilePlus2 size={13} aria-hidden />保存片段</button> : null}
    {onCreateCard || missingProvenance || querySaveUnsupported ? <button className={secondaryButtonClass} type="button" disabled={missingProvenance || querySaveUnsupported || !onCreateCard} onPointerDown={(event) => event.preventDefault()} onClick={onCreateCard}><Layers2 size={13} aria-hidden />制成卡片</button> : null}
    {querySaveUnsupported ? <p className="w-full text-xs leading-5 text-warn">临时系统查询暂不支持存为笔记或制成卡片；可复制结果，或使用保存会话保留本次查询快照。</p> : null}
    {missingProvenance ? <p className="w-full text-xs leading-5 text-warn">这条内容缺少可验证的来源上下文，无法保存为关联笔记或制成记忆卡片。请重新提问后保存新的片段。</p> : null}
    {error ? <p role="status" className="text-xs text-danger">{error}</p> : null}
  </div>;
}
