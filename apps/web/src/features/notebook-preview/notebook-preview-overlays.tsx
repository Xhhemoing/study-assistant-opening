import { Bot, FileText, MoreHorizontal, Share2, Sparkles } from "lucide-react";

import { ui } from "../opening/design/ui";
import { pageInfo } from "./notebook-preview-types";

export function PageActions({ onSelect }: { onSelect: (action: "ai" | "page-info" | "learn") => void }) {
  return <nav aria-label="页面操作" className="flex flex-wrap items-center gap-1 border-b border-zinc-200 px-4 py-2">
    <button className={ui.quiet} onClick={() => onSelect("learn")} type="button"><Sparkles aria-hidden="true" size={14} />体验学习模式</button>
    <button className={ui.quiet} onClick={() => onSelect("ai")} type="button"><Bot aria-hidden="true" size={14} />查看学习版示例</button>
    <button className={ui.quiet} onClick={() => onSelect("page-info")} type="button"><FileText aria-hidden="true" size={14} />示例页面信息</button>
  </nav>;
}

export function PageInfoOverlay() {
  return <><p className="mb-4 text-xs leading-6 text-zinc-500">以下属性均为示例，不对应已保存的笔记、来源或版本。</p><dl className="divide-y divide-zinc-200 text-xs">{pageInfo.map(({ label, value }) => <div className="grid grid-cols-[3rem_minmax(0,1fr)] gap-3 py-3" key={label}><dt className="text-zinc-500">{label}</dt><dd className="text-zinc-700">{value}</dd></div>)}</dl></>;
}

export function AiOverlay({ applied, onApply }: { applied: boolean; onApply: () => void }) {
  return <div className="space-y-4"><p className="text-sm leading-7 text-zinc-700">这是预先编写的学习版示例，没有发送材料或调用模型。切换后仅在当前页面显示。</p><section className="border-y border-zinc-200 py-3"><h3 className="text-xs font-medium text-zinc-800">示例提纲</h3><p className="mt-2 text-sm leading-7 text-zinc-600">识别先验 · 比较证据 · 算出后验 · 检查前提</p></section><button className={ui.primary} aria-pressed={applied} onClick={onApply} type="button">{applied ? "隐藏示例学习版" : "显示示例学习版"}</button><p className="text-xs leading-6 text-zinc-500">不会生成或保存 AI 候选。</p></div>;
}

export function ShareOverlay() {
  return <div className="space-y-4"><p className="text-sm leading-7 text-zinc-700">当前是示例笔记，未接入保存或分享。不会发布版本，也没有可复制的公开链接。</p><button className={ui.secondary} disabled type="button">分享尚不可用</button></div>;
}

export function MinimalHeader({ menuOpen, onMenu, onShare }: { menuOpen: boolean; onMenu: () => void; onShare: () => void }) {
  return <header className="flex min-h-12 shrink-0 items-center justify-between gap-2 border-b border-zinc-200 px-4"><div className="min-w-0 truncate text-xs text-zinc-500"><span className="font-medium text-zinc-900">AIstudy</span><span className="mx-2">/</span>笔记示例</div><div className="flex items-center gap-1"><button className={ui.quiet} onClick={onShare} type="button"><Share2 aria-hidden="true" size={14} />分享状态</button><button aria-expanded={menuOpen} aria-label="更多页面操作" className={ui.icon} onClick={onMenu} type="button"><MoreHorizontal aria-hidden="true" size={18} /></button></div></header>;
}

export function LearningModeBanner({ onExit }: { onExit: () => void }) {
  return <div className="mb-6 flex flex-wrap items-center justify-between gap-3 border-y border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800"><span>学习模式示例 · 提示为预设内容，不记录作答或安排复习。</span><button className={ui.secondary} onClick={onExit} type="button">返回阅读</button></div>;
}
