import {
  Archive,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsRight,
  CircleHelp,
  Copy,
  Download,
  FileText,
  FolderOpen,
  Link2,
  Lock,
  Menu,
  MoreHorizontal,
  PanelLeft,
  Search,
  Share2,
  Star,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import type { ReactNode } from "react";

export type WorkspacePanel = "actions" | "share" | null;
export type WorkspaceTextStyle = "default" | "serif" | "mono";

type WorkspaceProps = {
  children: ReactNode;
  documentTitle: string;
  fullWidth: boolean;
  onClosePanel: () => void;
  onOpenPage: (title: string) => void;
  onReset: () => void;
  onTextStyleChange: (style: WorkspaceTextStyle) => void;
  onToggleFullWidth: () => void;
  onTogglePanel: (panel: Exclude<WorkspacePanel, null>) => void;
  onToggleSidebar: () => void;
  pageCount: number;
  panel: WorkspacePanel;
  selectedPageTitle: string;
  sidebarOpen: boolean;
  textStyle: WorkspaceTextStyle;
};

const personalPages = ["概率推理笔记", "诊断测试的例子", "统计学习路线"];

function IconAction({ className = "", label, onClick, children }: { className?: string; label: string; onClick: () => void; children: ReactNode }) {
  return <button aria-label={label} className={`grid size-8 place-items-center rounded-md text-stone-400 hover:bg-white/10 hover:text-stone-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300 ${className}`} onClick={onClick} title={label} type="button">{children}</button>;
}

function Switch({ checked, label, onChange }: { checked: boolean; label: string; onChange: () => void }) {
  return <button aria-checked={checked} aria-label={label} className={`relative h-5 w-9 rounded-full transition ${checked ? "bg-sky-500" : "bg-stone-700"}`} onClick={onChange} role="switch" type="button"><span className={`absolute top-0.5 size-4 rounded-full bg-white transition ${checked ? "left-4" : "left-0.5"}`} /></button>;
}

function Sidebar({ onOpenPage, selectedPageTitle }: { onOpenPage: (title: string) => void; selectedPageTitle: string }) {
  return (
    <aside aria-label="工作区导航" className="hidden h-full w-60 shrink-0 flex-col border-r border-white/10 bg-[#202020] px-2 py-3 sm:flex">
      <div className="mb-4 flex items-center gap-2 px-2 text-sm font-medium text-stone-100"><span className="grid size-5 place-items-center rounded bg-stone-100 text-xs font-bold text-stone-900">A</span><span className="truncate">AIstudy workspace</span><ChevronDown aria-hidden="true" className="ml-auto text-stone-500" size={14} /></div>
      <nav aria-label="工作区快捷入口" className="mb-5 flex gap-1 px-1"><IconAction label="主页" onClick={() => undefined}><Menu aria-hidden="true" size={16} /></IconAction><IconAction label="搜索工作区" onClick={() => undefined}><Search aria-hidden="true" size={16} /></IconAction><IconAction label="导入归档" onClick={() => undefined}><Archive aria-hidden="true" size={16} /></IconAction></nav>
      <section>
        <h2 className="px-2 text-[11px] font-medium text-stone-500">Private</h2>
        <ul className="mt-1 space-y-0.5">{personalPages.map((title) => <li key={title}><button aria-current={title === selectedPageTitle ? "page" : undefined} className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${title === selectedPageTitle ? "bg-white/10 text-stone-100" : "text-stone-400 hover:bg-white/5 hover:text-stone-200"}`} onClick={() => onOpenPage(title)} type="button"><FileText aria-hidden="true" className="shrink-0 text-stone-500" size={14} /><span className="min-w-0 truncate">{title}</span></button></li>)}</ul>
      </section>
      <div className="mt-auto space-y-1 border-t border-white/10 pt-3"><button className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-stone-400 hover:bg-white/5 hover:text-stone-200" type="button"><FolderOpen aria-hidden="true" size={15} />Library</button><button className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-stone-400 hover:bg-white/5 hover:text-stone-200" type="button"><CircleHelp aria-hidden="true" size={15} />帮助</button><button className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-stone-400 hover:bg-white/5 hover:text-stone-200" type="button"><Trash2 aria-hidden="true" size={15} />回收站</button></div>
    </aside>
  );
}

function ActionMenu({ fullWidth, onClose, onReset, onTextStyleChange, onToggleFullWidth, textStyle }: { fullWidth: boolean; onClose: () => void; onReset: () => void; onTextStyleChange: (style: WorkspaceTextStyle) => void; onToggleFullWidth: () => void; textStyle: WorkspaceTextStyle }) {
  const styles: { id: WorkspaceTextStyle; label: string; className: string }[] = [{ id: "default", label: "Default", className: "font-sans" }, { id: "serif", label: "Serif", className: "font-serif" }, { id: "mono", label: "Mono", className: "font-mono" }];
  return (
    <aside aria-label="页面操作菜单" className="absolute right-4 top-12 z-30 w-[19rem] overflow-hidden rounded-xl border border-white/10 bg-[#2a2a2a] p-2 shadow-2xl sm:right-6">
      <div className="flex justify-end"><IconAction label="关闭页面操作菜单" onClick={onClose}><X aria-hidden="true" size={15} /></IconAction></div>
      <label className="flex h-9 items-center gap-2 rounded-md border border-sky-400 bg-[#222] px-2 text-stone-400 ring-1 ring-sky-400/50"><Search aria-hidden="true" size={14} /><input aria-label="Search actions" className="min-w-0 flex-1 bg-transparent text-sm text-stone-100 outline-none placeholder:text-stone-500" placeholder="Search actions..." /></label>
      <div className="mt-2 border-b border-white/10 pb-2">{styles.map((style) => <button aria-pressed={textStyle === style.id} className={`flex w-full items-center rounded-md px-2.5 py-2 text-left text-sm hover:bg-white/10 ${textStyle === style.id ? "text-sky-300" : "text-stone-300"} ${style.className}`} key={style.id} onClick={() => onTextStyleChange(style.id)} type="button">{style.label}</button>)}</div>
      <div className="border-b border-white/10 py-2"><button className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-stone-300 hover:bg-white/10" type="button"><Link2 aria-hidden="true" size={15} />Copy link</button><button className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-stone-300 hover:bg-white/10" type="button"><Copy aria-hidden="true" size={15} />Copy page contents</button><button className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-stone-300 hover:bg-white/10" onClick={onReset} type="button"><Upload aria-hidden="true" size={15} />Import another export</button></div>
      <div className="space-y-1 border-b border-white/10 py-2"><div className="flex items-center justify-between px-2.5 py-1.5 text-sm text-stone-300"><span>Small text</span><Switch checked={false} label="Small text" onChange={() => undefined} /></div><div className="flex items-center justify-between px-2.5 py-1.5 text-sm text-stone-300"><span>Full width</span><Switch checked={fullWidth} label="Full width" onChange={onToggleFullWidth} /></div></div>
      <div className="pt-2"><button className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-stone-300 hover:bg-white/10" type="button"><Download aria-hidden="true" size={15} />Export report</button><button className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-stone-300 hover:bg-white/10" type="button"><Lock aria-hidden="true" size={15} />Keep source private</button></div>
    </aside>
  );
}

function SharePanel({ onClose }: { onClose: () => void }) {
  return <aside aria-label="分享面板" className="absolute right-4 top-12 z-30 w-[19rem] rounded-xl border border-white/10 bg-[#2a2a2a] p-4 shadow-2xl sm:right-6"><header className="flex items-center justify-between"><h2 className="text-sm font-semibold text-stone-100">Share import preview</h2><IconAction label="关闭分享面板" onClick={onClose}><X aria-hidden="true" size={15} /></IconAction></header><p className="mt-3 text-sm leading-6 text-stone-400">发布的是固定版本预览。原始 ZIP、学习记录和私有来源锚点不会公开。</p><div className="mt-4 flex items-center justify-between border-t border-white/10 pt-3 text-sm text-stone-300"><span>Keep source private</span><Lock aria-hidden="true" className="text-stone-500" size={15} /></div></aside>;
}

export function NotionImportWorkspace({ children, documentTitle, fullWidth, onClosePanel, onOpenPage, onReset, onTextStyleChange, onToggleFullWidth, onTogglePanel, onToggleSidebar, panel, selectedPageTitle, sidebarOpen, textStyle }: WorkspaceProps) {
  return (
    <main className="notebook-preview scheme-dark flex min-h-screen overflow-x-hidden bg-[#191919] text-stone-100">
      {sidebarOpen ? <Sidebar onOpenPage={onOpenPage} selectedPageTitle={selectedPageTitle} /> : null}
      <section className="min-w-0 flex-1">
        <header className="sticky top-0 z-20 flex h-12 items-center justify-between gap-2 border-b border-white/10 bg-[#191919]/95 px-3 backdrop-blur sm:px-5"><div className="flex min-w-0 items-center gap-1"><IconAction label="切换侧边栏" onClick={onToggleSidebar}><PanelLeft aria-hidden="true" size={16} /></IconAction><IconAction className="hidden sm:grid" label="后退" onClick={() => undefined}><ChevronLeft aria-hidden="true" size={16} /></IconAction><IconAction className="hidden sm:grid" label="前进" onClick={() => undefined}><ChevronRight aria-hidden="true" size={16} /></IconAction><div className="ml-1 min-w-0 truncate text-sm text-stone-400 sm:ml-2"><span className="hidden sm:inline">Private / </span>{documentTitle}</div></div><div className="flex shrink-0 items-center gap-1"><button aria-label="分享当前导入预览" className="inline-flex h-8 items-center gap-1.5 rounded-md border border-white/15 px-2.5 text-sm font-medium text-stone-100 hover:bg-white/10" onClick={() => onTogglePanel("share")} type="button"><Share2 aria-hidden="true" size={14} /><span className="hidden sm:inline">Share</span></button><IconAction className="hidden sm:grid" label="复制导入预览链接" onClick={() => undefined}><Link2 aria-hidden="true" size={16} /></IconAction><IconAction className="hidden sm:grid" label="收藏导入预览" onClick={() => undefined}><Star aria-hidden="true" size={16} /></IconAction><IconAction label="更多页面操作" onClick={() => onTogglePanel("actions")}><MoreHorizontal aria-hidden="true" size={18} /></IconAction></div></header>
        <div className="relative min-h-[calc(100vh-3rem)]"><div className={fullWidth ? "mx-auto max-w-[88rem]" : "mx-auto max-w-[66rem]"}>{children}</div>{panel === "actions" ? <ActionMenu fullWidth={fullWidth} onClose={onClosePanel} onReset={onReset} onTextStyleChange={onTextStyleChange} onToggleFullWidth={onToggleFullWidth} textStyle={textStyle} /> : null}{panel === "share" ? <SharePanel onClose={onClosePanel} /> : null}</div>
      </section>
    </main>
  );
}

export function WorkspaceCollapseButton({ onClick }: { onClick: () => void }) {
  return <button aria-label="展开侧边栏" className="fixed bottom-4 left-4 z-50 grid size-9 place-items-center rounded-full border border-white/10 bg-[#292929] text-stone-400 shadow-lg hover:bg-white/10 hover:text-white" onClick={onClick} type="button"><ChevronsRight aria-hidden="true" size={16} /></button>;
}
