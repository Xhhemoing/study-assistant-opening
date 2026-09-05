import {
  Bot,
  Check,
  ChevronDown,
  Copy,
  FileText,
  Link2,
  MoreHorizontal,
  Share2,
  Sparkles,
  X,
} from "lucide-react";
import type { ReactNode } from "react";

import { pageInfo } from "./notebook-preview-types";

function Overlay({ children, onClose, title }: { children: ReactNode; onClose: () => void; title: string }) {
  return (
    <aside aria-label={title} className="absolute right-0 top-11 z-30 w-[min(22rem,calc(100vw-2rem))] rounded-lg border border-white/10 bg-[#242424] p-4 shadow-2xl">
      <header className="flex items-center justify-between border-b border-white/10 pb-3">
        <h2 className="text-sm font-semibold text-stone-100">{title}</h2>
        <button aria-label="关闭面板" className="grid size-8 place-items-center rounded text-stone-400 hover:bg-white/10 hover:text-white" onClick={onClose} type="button">
          <X aria-hidden="true" size={16} />
        </button>
      </header>
      {children}
    </aside>
  );
}

export function PageActions({ onSelect }: { onSelect: (action: "ai" | "page-info" | "learn") => void }) {
  return (
    <div className="absolute right-0 top-11 z-30 w-52 rounded-lg border border-white/10 bg-[#242424] p-1.5 shadow-2xl">
      <button className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-stone-200 hover:bg-white/10" onClick={() => onSelect("learn")} type="button">
        <Sparkles aria-hidden="true" size={15} />进入学习模式
      </button>
      <button className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-stone-200 hover:bg-white/10" onClick={() => onSelect("ai")} type="button">
        <Bot aria-hidden="true" size={15} />AI 助手
      </button>
      <button className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-stone-200 hover:bg-white/10" onClick={() => onSelect("page-info")} type="button">
        <FileText aria-hidden="true" size={15} />页面信息
      </button>
    </div>
  );
}

export function PageInfoOverlay({ onClose }: { onClose: () => void }) {
  return (
    <Overlay onClose={onClose} title="页面信息">
      <dl className="mt-4 space-y-3 text-sm">
        {pageInfo.map(({ label, value }) => (
          <div className="grid grid-cols-[4rem_minmax(0,1fr)] gap-3" key={label}>
            <dt className="text-stone-500">{label}</dt>
            <dd className={label === "来源" ? "text-sky-300" : "text-stone-200"}>{value}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-5 border-t border-white/10 pt-4 text-xs leading-5 text-stone-500">最后编辑于今天 14:32 · 林同学</div>
    </Overlay>
  );
}

export function AiOverlay({ applied, onApply, onClose }: { applied: boolean; onApply: () => void; onClose: () => void }) {
  return (
    <Overlay onClose={onClose} title="AI 助手">
      <div className="mt-4 border-l-2 border-sky-300/70 pl-3 text-sm text-sky-100">
        <div className="flex items-center gap-2 font-semibold"><Bot aria-hidden="true" size={16} />理解这个章节</div>
        <p className="mt-2 text-xs leading-5 text-stone-400">本次范围：第 2 节、相邻 4 个块与 1 个来源锚点。只生成候选，不会直接修改笔记。</p>
      </div>
      <section className="mt-5 border-t border-white/10 pt-4">
        <h3 className="text-sm font-medium text-stone-100">学习版候选</h3>
        <p className="mt-1 text-xs leading-5 text-stone-400">识别先验 · 比较证据 · 算出后验 · 检查前提</p>
      </section>
      <button className="mt-5 inline-flex h-9 items-center gap-2 rounded border border-sky-300/50 px-3 text-sm font-semibold text-sky-200 hover:bg-sky-300/10" onClick={onApply} type="button">
        <Copy aria-hidden="true" size={14} />{applied ? "已应用到预览" : "生成学习版候选"}
      </button>
    </Overlay>
  );
}

export function ShareOverlay({ onClose }: { onClose: () => void }) {
  return (
    <Overlay onClose={onClose} title="发布与分享">
      <p className="mt-4 text-sm leading-6 text-stone-300">发布固定版本；读者的练习、复习和 AI 记录不会公开。</p>
      <div className="mt-4 flex gap-2">
        <button className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded bg-stone-100 px-3 text-xs font-semibold text-stone-900 hover:bg-white" type="button"><Share2 aria-hidden="true" size={14} />发布 v12</button>
        <button className="inline-flex size-9 items-center justify-center rounded border border-white/10 text-stone-300 hover:bg-white/10" title="复制页面链接" type="button"><Link2 aria-hidden="true" size={15} /></button>
      </div>
    </Overlay>
  );
}

export function MinimalHeader({
  menuOpen,
  onMenu,
  onShare,
}: {
  menuOpen: boolean;
  onMenu: () => void;
  onShare: () => void;
}) {
  return (
    <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-2 border-b border-white/10 bg-[#191919]/95 px-4 backdrop-blur sm:px-6">
      <div className="min-w-0 truncate text-sm text-stone-400"><span className="font-medium text-stone-100">AIstudy</span><span className="mx-2 text-stone-600">/</span><span className="hidden sm:inline">概率推理</span><span className="sm:hidden">笔记</span></div>
      <div className="flex items-center gap-1">
        <span className="hidden items-center gap-1 text-xs text-stone-500 sm:inline-flex"><Check aria-hidden="true" size={13} />已保存</span>
        <button className="inline-flex h-8 items-center gap-1.5 rounded-md border border-white/15 px-2.5 text-sm font-medium text-stone-100 hover:bg-white/10" onClick={onShare} type="button"><Share2 aria-hidden="true" size={14} />分享</button>
        <div className="relative">
          <button aria-expanded={menuOpen} aria-label="更多页面操作" className="grid size-8 place-items-center rounded-md text-stone-400 hover:bg-white/10 hover:text-white" onClick={onMenu} type="button"><MoreHorizontal aria-hidden="true" size={18} /></button>
        </div>
      </div>
    </header>
  );
}

export function LearningModeBanner({ onExit }: { onExit: () => void }) {
  return <div className="mb-10 flex items-center justify-between gap-3 border-y border-amber-200/20 bg-amber-200/10 px-4 py-3 text-sm text-amber-100"><span>学习版只记录你的作答和复习安排。</span><button className="shrink-0 text-xs font-semibold text-amber-200 hover:text-white" onClick={onExit} type="button">返回编辑</button></div>;
}

export function CompactControl({ children, label, onClick }: { children: ReactNode; label: string; onClick: () => void }) {
  return <button aria-label={label} className="grid size-7 place-items-center rounded text-stone-600 opacity-0 transition group-hover:opacity-100 hover:bg-white/10 hover:text-stone-200 focus:opacity-100" onClick={onClick} title={label} type="button">{children}</button>;
}
