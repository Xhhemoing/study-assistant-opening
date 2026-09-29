import { FileText, PanelLeft, Settings2, Share2, Upload } from "lucide-react";
import type { ReactNode } from "react";

import { Inspector } from "../opening/design/inspector";
import { ui } from "../opening/design/ui";

export type WorkspacePanel = "actions" | "share" | null;
export type WorkspaceTextStyle = "default" | "serif" | "mono";

type WorkspaceProps = {
  children: ReactNode;
  documentTitle: string;
  fullWidth: boolean;
  onClosePanel: () => void;
  onExportReport: () => void;
  onOpenPage: (id: string) => void;
  onReset: () => void;
  onTextStyleChange: (style: WorkspaceTextStyle) => void;
  onToggleFullWidth: () => void;
  onTogglePanel: (panel: Exclude<WorkspacePanel, null>) => void;
  onToggleSidebar: () => void;
  pages: { id: string; title: string; path: string }[];
  panel: WorkspacePanel;
  selectedPageId: string;
  sidebarOpen: boolean;
  textStyle: WorkspaceTextStyle;
};

function AppearancePanel({ fullWidth, onExportReport, onReset, onTextStyleChange, onToggleFullWidth, textStyle }: Pick<WorkspaceProps, "fullWidth" | "onExportReport" | "onReset" | "onTextStyleChange" | "onToggleFullWidth" | "textStyle">) {
  const styles = [{ id: "default", label: "默认", className: "font-sans" }, { id: "serif", label: "衬线", className: "font-serif" }, { id: "mono", label: "等宽", className: "font-mono" }] as const;
  return <div className="space-y-6">
    <fieldset><legend className={`${ui.label} mb-2`}>阅读字体</legend><div className="flex flex-wrap gap-1">{styles.map(style => <button key={style.id} type="button" aria-pressed={textStyle === style.id} className={`${ui.secondary} ${style.className} ${textStyle === style.id ? "border-emerald-300 bg-emerald-50 text-emerald-800" : ""}`} onClick={() => onTextStyleChange(style.id)}>{style.label}</button>)}</div></fieldset>
    <label className="flex items-center justify-between gap-3 text-sm text-zinc-700">宽版阅读<input type="checkbox" checked={fullWidth} onChange={onToggleFullWidth} className="size-4 accent-emerald-700" /></label>
    <div className="flex flex-col items-start gap-2 border-t border-zinc-200 pt-4"><button type="button" className={ui.secondary} onClick={onExportReport}>下载格式损失报告</button><button type="button" className={ui.quiet} onClick={onReset}><Upload size={14} aria-hidden="true" />重新选择 ZIP</button></div>
    <p className="text-xs leading-6 text-zinc-500">外观设置仅用于本次预览。文件在本地解析，未写入知识库。</p>
  </div>;
}

export function NotionImportWorkspace(props: WorkspaceProps) {
  const { children, documentTitle, fullWidth, onClosePanel, onOpenPage, onReset, onTogglePanel, onToggleSidebar, pages, panel, selectedPageId, sidebarOpen } = props;
  return <main className="flex h-dvh min-h-0 flex-col overflow-hidden bg-white text-zinc-900">
    <header className="flex min-h-12 shrink-0 items-center justify-between gap-2 border-b border-zinc-200 px-3">
      <div className="flex min-w-0 items-center gap-2"><button aria-label="切换页面列表" aria-expanded={sidebarOpen} className={`${ui.icon} hidden md:inline-flex`} onClick={onToggleSidebar} type="button"><PanelLeft size={16} aria-hidden="true" /></button><span className="hidden shrink-0 text-xs text-zinc-500 sm:inline">本地导入预览 /</span><span className="truncate text-sm font-medium">{documentTitle}</span></div>
      <div className="flex shrink-0 gap-1"><button aria-label="查看分享状态" className={ui.quiet} onClick={() => onTogglePanel("share")} type="button"><Share2 size={14} aria-hidden="true" /><span className="hidden sm:inline">分享状态</span></button><button aria-label="外观与导入操作" aria-expanded={panel === "actions"} className={ui.icon} onClick={() => onTogglePanel("actions")} type="button"><Settings2 size={16} aria-hidden="true" /></button></div>
    </header>
    <div className="flex min-h-0 flex-1">
      {sidebarOpen ? <aside aria-label="导入页面导航" className="hidden w-64 shrink-0 flex-col border-r border-zinc-200 bg-zinc-50 md:flex"><div className="flex h-12 items-center justify-between px-4 text-xs font-medium text-zinc-600"><h2>导入页面</h2><span className="tabular-nums">{pages.length}</span></div><nav className="min-h-0 flex-1 overflow-y-auto px-2"><ul className="space-y-0.5">{pages.map(page => <li key={page.path}><button aria-current={page.id === selectedPageId ? "page" : undefined} className={`${ui.quiet} w-full justify-start py-2 text-left ${page.id === selectedPageId ? "bg-emerald-50 text-emerald-800" : ""}`} onClick={() => onOpenPage(page.id)} title={page.path} type="button"><FileText size={14} className="shrink-0" aria-hidden="true" /><span className="truncate">{page.title}</span></button></li>)}</ul></nav><div className="border-t border-zinc-200 p-3"><button type="button" className={`${ui.secondary} w-full`} onClick={onReset}><Upload size={14} aria-hidden="true" />重新选择 ZIP</button></div></aside> : null}
      <section className="min-w-0 flex-1 overflow-y-auto">
        <div className="border-b border-zinc-200 p-3 md:hidden"><label className={ui.label}>当前页面<select className={`${ui.input} mt-1`} value={selectedPageId} onChange={event => onOpenPage(event.target.value)}>{pages.map(page => <option key={page.path} value={page.id}>{page.title}</option>)}</select></label></div>
        <div className="border-b border-zinc-200 bg-zinc-50 px-4 py-2 text-xs leading-5 text-zinc-500">本地解析 · 未上传或保存到知识库 · 刷新后清除</div>
        <div className={`mx-auto ${fullWidth ? "max-w-[88rem]" : "max-w-[66rem]"}`}>{children}</div>
      </section>
      <Inspector open={panel !== null} onClose={onClosePanel} title={panel === "share" ? "分享状态" : "外观与导入操作"} id="notion-preview-context">{panel === "actions" ? <AppearancePanel {...props} /> : <div className="space-y-4"><p className="text-sm leading-7 text-zinc-700">当前为本地导入预览，尚未接入发布、分享链接或存入知识库。</p><button type="button" disabled className={ui.secondary}>分享尚不可用</button><p className="text-xs leading-6 text-zinc-500">没有生成公开版本或链接。请保留原始 ZIP 文件。</p></div>}</Inspector>
    </div>
  </main>;
}
