"use client";

import {
  AlignLeft,
  Archive,
  ArrowLeft,
  Bold,
  BookOpen,
  Bot,
  Braces,
  Check,
  CheckSquare2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  ClipboardCheck,
  Copy,
  Download,
  FileText,
  GripVertical,
  Heading2,
  Image as ImageIcon,
  Italic,
  LayoutPanelTop,
  Link2,
  List,
  ListChecks,
  ListTree,
  MessageSquareText,
  MoreHorizontal,
  PanelRightOpen,
  PencilLine,
  Play,
  Plus,
  Quote,
  Redo2,
  RotateCcw,
  Search,
  Share2,
  Sparkles,
  Table2,
  TableProperties,
  Trash2,
  Undo2,
  Upload,
  Video,
  WandSparkles,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

type NotebookMode = "edit" | "read" | "learn";
type DrawerName = "outline" | "context" | "ai" | "share" | "export" | null;
type WidthMode = "comfortable" | "wide" | "full";
type PopoverName = "blocks" | "format" | null;

type IconType = typeof FileText;

type ModeOption = {
  id: NotebookMode;
  label: string;
  icon: IconType;
};

type DrawerButtonProps = {
  active: boolean;
  icon: IconType;
  label: string;
  onClick: () => void;
};

type BlockOption = {
  label: string;
  description: string;
  icon: IconType;
  actionName: string;
  group: "基础内容" | "媒体与数据" | "学习闭环";
};

const modes: ModeOption[] = [
  { id: "edit", label: "编辑", icon: PencilLine },
  { id: "read", label: "阅读", icon: BookOpen },
  { id: "learn", label: "学习", icon: Play },
];

const outlineItems = [
  { label: "贝叶斯公式到底在说什么", depth: 0, active: true },
  { label: "从先验到后验", depth: 0 },
  { label: "一个诊断测试的例子", depth: 1 },
  { label: "何时不能直接使用", depth: 0 },
  { label: "练习：重新推理", depth: 0 },
];

const pageTree = [
  { label: "概率推理", icon: FileText, active: true, nested: false },
  { label: "条件概率的语言", icon: FileText, active: false, nested: true },
  { label: "诊断测试的误读", icon: FileText, active: false, nested: true },
  { label: "统计学习路线", icon: BookOpen, active: false, nested: false },
];

const blockOptions: BlockOption[] = [
  { label: "文本", description: "开始写作", icon: AlignLeft, actionName: "插入文本块", group: "基础内容" },
  { label: "标题 2", description: "组织页面层级", icon: Heading2, actionName: "插入标题块", group: "基础内容" },
  { label: "待办", description: "追踪一个行动", icon: CheckSquare2, actionName: "插入待办块", group: "基础内容" },
  { label: "引用", description: "强调一段原文", icon: Quote, actionName: "插入引用块", group: "基础内容" },
  { label: "表格", description: "比较或整理数据", icon: Table2, actionName: "插入表格块", group: "媒体与数据" },
  { label: "图片", description: "添加可访问的视觉材料", icon: ImageIcon, actionName: "插入图片块", group: "媒体与数据" },
  { label: "视频", description: "嵌入学习资料", icon: Video, actionName: "插入视频块", group: "媒体与数据" },
  { label: "概念", description: "给术语一个可引用定义", icon: Braces, actionName: "插入概念块", group: "学习闭环" },
  { label: "来源摘录", description: "保留原文与页码锚点", icon: Link2, actionName: "插入来源摘录块", group: "学习闭环" },
  { label: "回忆提示", description: "先回忆，再显示提示", icon: Sparkles, actionName: "插入回忆提示块", group: "学习闭环" },
  { label: "练习", description: "创建独立作答任务", icon: ClipboardCheck, actionName: "插入练习块", group: "学习闭环" },
];

function IconButton({
  label,
  children,
  onClick,
  pressed,
  className = "",
}: {
  label: string;
  children: ReactNode;
  onClick?: () => void;
  pressed?: boolean;
  className?: string;
}) {
  return (
    <button
      aria-label={label}
      aria-pressed={pressed}
      className={`inline-grid size-9 shrink-0 place-items-center rounded-[6px] text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${className}`}
      onClick={onClick}
      title={label}
      type="button"
    >
      {children}
    </button>
  );
}

function DrawerButton({ active, icon: Icon, label, onClick }: DrawerButtonProps) {
  return (
    <button
      aria-label={label}
      aria-pressed={active}
      className={`inline-grid size-10 place-items-center rounded-[6px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${active ? "bg-sky-50 text-sky-700" : "text-stone-500 hover:bg-stone-100 hover:text-stone-900"}`}
      onClick={onClick}
      title={label}
      type="button"
    >
      <Icon aria-hidden="true" size={18} strokeWidth={1.8} />
    </button>
  );
}

function SegmentedModes({ mode, onChange }: { mode: NotebookMode; onChange: (mode: NotebookMode) => void }) {
  return (
    <div aria-label="笔记模式" className="inline-flex rounded-[7px] bg-stone-100 p-1" role="group">
      {modes.map(({ id, label, icon: Icon }) => (
        <button
          aria-pressed={mode === id}
          className={`inline-flex h-8 items-center gap-1.5 rounded-[5px] px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${mode === id ? "bg-white text-stone-950 shadow-sm" : "text-stone-500 hover:text-stone-800"}`}
          key={id}
          onClick={() => onChange(id)}
          type="button"
        >
          <Icon aria-hidden="true" size={14} strokeWidth={1.9} />
          {label}
        </button>
      ))}
    </div>
  );
}

function DrawerShell({ children, onClose, title }: { children: ReactNode; onClose: () => void; title: string }) {
  return (
    <aside aria-label={title} className="flex h-[calc(100vh-3.5rem)] w-[20rem] shrink-0 flex-col border-l border-stone-200 bg-white shadow-[-10px_0_28px_rgba(28,25,23,0.05)]">
      <header className="flex h-14 items-center justify-between border-b border-stone-200 px-4">
        <h2 className="text-sm font-semibold text-stone-900">{title}</h2>
        <IconButton label="关闭面板" onClick={onClose}><X aria-hidden="true" size={17} /></IconButton>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">{children}</div>
    </aside>
  );
}

function WorkspaceSidebar() {
  return (
    <aside aria-label="工作区导航" className="hidden w-[15.5rem] shrink-0 border-r border-stone-200 bg-stone-50 lg:flex lg:flex-col">
      <header className="flex h-14 items-center gap-2 px-3">
        <button className="flex min-w-0 flex-1 items-center gap-2 rounded-[6px] px-2 py-1.5 text-left hover:bg-stone-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500" type="button">
          <span className="grid size-6 place-items-center rounded-[5px] bg-stone-900 text-[10px] font-bold text-white">A</span>
          <span className="truncate text-sm font-semibold text-stone-800">AIstudy</span>
          <ChevronDown aria-hidden="true" className="ml-auto text-stone-400" size={14} />
        </button>
        <IconButton label="工作区搜索"><Search aria-hidden="true" size={16} /></IconButton>
      </header>
      <div className="px-3 pb-3">
        <button className="flex min-h-9 w-full items-center gap-2 rounded-[6px] px-2 text-sm text-stone-600 hover:bg-stone-100" type="button"><Search aria-hidden="true" size={15} />搜索 <kbd className="ml-auto rounded border border-stone-200 bg-white px-1.5 py-0.5 text-[10px] text-stone-400">⌘ K</kbd></button>
        <button className="mt-1 flex min-h-9 w-full items-center gap-2 rounded-[6px] px-2 text-sm text-stone-600 hover:bg-stone-100" type="button"><MessageSquareText aria-hidden="true" size={15} />更新与收件箱</button>
        <button className="mt-1 flex min-h-9 w-full items-center gap-2 rounded-[6px] px-2 text-sm text-stone-600 hover:bg-stone-100" type="button"><ListChecks aria-hidden="true" size={15} />我的任务</button>
      </div>
      <nav aria-label="笔记页面" className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        <div className="mb-2 flex items-center justify-between px-2"><span className="text-[11px] font-medium text-stone-400">私有</span><IconButton label="新建页面"><Plus aria-hidden="true" size={14} /></IconButton></div>
        <div className="space-y-0.5">
          {pageTree.map(({ label, icon: Icon, active, nested }) => (
            <button className={`flex min-h-8 w-full items-center gap-2 rounded-[5px] px-2 text-left text-sm ${nested ? "pl-7" : ""} ${active ? "bg-stone-200/80 font-medium text-stone-900" : "text-stone-600 hover:bg-stone-100"}`} key={label} type="button"><Icon aria-hidden="true" size={15} className={active ? "text-stone-700" : "text-stone-400"} /><span className="truncate">{label}</span></button>
          ))}
        </div>
        <div className="mt-6 px-2 text-[11px] font-medium text-stone-400">共享</div>
        <button className="mt-2 flex min-h-8 w-full items-center gap-2 rounded-[5px] px-2 text-sm text-stone-600 hover:bg-stone-100" type="button"><BookOpen aria-hidden="true" size={15} className="text-stone-400" />概率论学习小组</button>
      </nav>
      <footer className="border-t border-stone-200 p-3">
        <button className="flex min-h-9 w-full items-center gap-2 rounded-[6px] px-2 text-left text-sm text-stone-600 hover:bg-stone-100" type="button"><Trash2 aria-hidden="true" size={15} className="text-stone-400" />垃圾箱</button>
        <button className="mt-2 flex min-h-9 w-full items-center gap-2 rounded-[6px] px-2 text-left hover:bg-stone-100" type="button"><span className="grid size-6 place-items-center rounded-full bg-amber-100 text-[10px] font-semibold text-amber-800">林</span><span className="text-sm text-stone-700">林同学</span><MoreHorizontal aria-hidden="true" className="ml-auto text-stone-400" size={16} /></button>
      </footer>
    </aside>
  );
}

function OutlineDrawer({ onClose }: { onClose: () => void }) {
  return (
    <DrawerShell onClose={onClose} title="目录">
      <nav aria-label="文档目录" className="space-y-1">
        {outlineItems.map((item) => (
          <button className={`flex w-full items-center gap-2 rounded-[6px] px-2 py-2 text-left text-sm leading-5 transition-colors hover:bg-stone-50 ${item.depth === 1 ? "pl-6" : ""} ${item.active ? "bg-sky-50 font-medium text-sky-800" : "text-stone-600"}`} key={item.label} type="button"><span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-40" /><span>{item.label}</span></button>
        ))}
      </nav>
      <div className="mt-8 border-t border-stone-200 pt-5">
        <p className="text-xs font-medium text-stone-400">本文档</p>
        <dl className="mt-3 grid grid-cols-2 gap-y-3 text-xs">
          <div><dt className="text-stone-400">内容块</dt><dd className="mt-0.5 font-medium text-stone-700">18</dd></div>
          <div><dt className="text-stone-400">当前版本</dt><dd className="mt-0.5 font-medium text-stone-700">v12</dd></div>
          <div><dt className="text-stone-400">最后编辑</dt><dd className="mt-0.5 font-medium text-stone-700">今天 14:32</dd></div>
        </dl>
      </div>
    </DrawerShell>
  );
}

function ContextDrawer({ onClose }: { onClose: () => void }) {
  return (
    <DrawerShell onClose={onClose} title="文档关系">
      <section className="border-b border-stone-200 pb-5">
        <p className="text-xs font-medium text-stone-400">标签</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {["概率论", "决策", "统计基础"].map((tag) => <span className="rounded-[5px] bg-stone-100 px-2 py-1 text-xs font-medium text-stone-600" key={tag}>{tag}</span>)}
          <button aria-label="添加标签" className="inline-grid size-7 place-items-center rounded-[5px] border border-dashed border-stone-300 text-stone-400 hover:border-stone-500 hover:text-stone-700" type="button"><Plus aria-hidden="true" size={14} /></button>
        </div>
      </section>
      <section className="border-b border-stone-200 py-5">
        <p className="text-xs font-medium text-stone-400">来源</p>
        <button className="mt-3 flex w-full items-start gap-2 rounded-[6px] border border-stone-200 p-3 text-left hover:bg-stone-50" type="button"><Link2 aria-hidden="true" className="mt-0.5 shrink-0 text-sky-700" size={15} /><span><span className="block text-sm font-medium text-stone-700">医学检测与贝叶斯更新</span><span className="mt-1 block text-xs leading-5 text-stone-400">教材选段 · 已锚定第 42 页</span></span></button>
      </section>
      <section className="pt-5">
        <p className="text-xs font-medium text-stone-400">相关笔记</p>
        <div className="mt-2 space-y-1">{["条件概率的语言", "独立性不是互不相关", "诊断测试的误读"].map((note) => <button className="flex w-full items-center gap-2 rounded-[6px] px-2 py-2 text-left text-sm text-stone-600 hover:bg-stone-50" key={note} type="button"><FileText aria-hidden="true" size={14} className="text-stone-400" />{note}</button>)}</div>
      </section>
    </DrawerShell>
  );
}

function AiDrawer({ applied, onApply, onClose }: { applied: boolean; onApply: () => void; onClose: () => void }) {
  return (
    <DrawerShell onClose={onClose} title="AI 助手">
      <div className="rounded-[7px] border border-sky-100 bg-sky-50 p-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-sky-900"><Bot aria-hidden="true" size={16} />理解这个章节</div>
        <p className="mt-2 text-xs leading-5 text-sky-800">本次范围：第 2 节、相邻 4 个块与 1 个来源锚点。只生成候选，不会直接修改笔记。</p>
      </div>
      <div className="mt-5 space-y-2">
        <p className="text-xs font-medium text-stone-400">可生成</p>
        {["解释难点", "找出隐含前提", "制作回忆卡", "转换为学习版"].map((action) => <button className="flex w-full items-center justify-between rounded-[6px] border border-stone-200 px-3 py-2.5 text-left text-sm text-stone-700 hover:border-stone-300 hover:bg-stone-50" key={action} type="button"><span>{action}</span><ChevronRight aria-hidden="true" size={15} className="text-stone-400" /></button>)}
      </div>
      <section className="mt-6 border-t border-stone-200 pt-5">
        <h3 className="text-xs font-medium text-stone-400">学习版候选</h3>
        <div className="mt-3 rounded-[7px] border border-stone-200 p-3">
          <p className="text-sm font-medium text-stone-800">从概念到练习的 4 步路径</p>
          <p className="mt-1 text-xs leading-5 text-stone-500">识别先验 · 比较证据 · 算出后验 · 检查前提</p>
          <div className="mt-3 flex items-center gap-2"><button className="inline-flex h-8 items-center gap-1.5 rounded-[5px] bg-sky-700 px-2.5 text-xs font-semibold text-white hover:bg-sky-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500" onClick={onApply} type="button"><Copy aria-hidden="true" size={13} />{applied ? "已应用到预览" : "应用到预览"}</button><button className="inline-flex h-8 items-center gap-1.5 rounded-[5px] border border-stone-200 px-2.5 text-xs font-medium text-stone-600 hover:bg-stone-50" type="button"><X aria-hidden="true" size={13} />忽略</button></div>
        </div>
      </section>
      <button className="mt-5 inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-[6px] border border-sky-700 px-3 text-sm font-semibold text-sky-800 hover:bg-sky-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500" onClick={onApply} type="button"><WandSparkles aria-hidden="true" size={15} />生成学习版候选</button>
      <p className="mt-3 text-xs leading-5 text-stone-400">候选会保留来源块、版本和变更说明，需确认后才会进入正式内容。</p>
    </DrawerShell>
  );
}

function ShareDrawer({ onClose }: { onClose: () => void }) {
  return (
    <DrawerShell onClose={onClose} title="发布与分享">
      <div className="rounded-[7px] border border-stone-200 p-4">
        <p className="text-sm font-semibold text-stone-900">版本化只读发布</p>
        <p className="mt-1 text-xs leading-5 text-stone-500">读者查看固定版本；他们的练习、复习和 AI 记录不会公开。</p>
        <div className="mt-4 grid grid-cols-2 gap-2"><button className="inline-flex h-9 items-center justify-center rounded-[5px] bg-sky-700 px-3 text-xs font-semibold text-white hover:bg-sky-800" type="button">发布 v12</button><button className="inline-flex h-9 items-center justify-center rounded-[5px] border border-stone-200 px-3 text-xs font-semibold text-stone-600 hover:bg-stone-50" type="button">预览读者页</button></div>
      </div>
      <section className="mt-6"><p className="text-xs font-medium text-stone-400">读者可做什么</p><div className="mt-3 space-y-3 text-sm text-stone-600"><label className="flex items-center justify-between gap-3"><span>查看内容与来源</span><input className="size-4 accent-sky-700" defaultChecked type="checkbox" /></label><label className="flex items-center justify-between gap-3"><span>Fork 为个人副本</span><input className="size-4 accent-sky-700" defaultChecked type="checkbox" /></label><label className="flex items-center justify-between gap-3"><span>下载导出文件</span><input className="size-4 accent-sky-700" type="checkbox" /></label></div></section>
    </DrawerShell>
  );
}

function ExportDrawer({ onClose }: { onClose: () => void }) {
  const formats: Array<[IconType, string, string]> = [
    [Archive, "AIstudy 原生包", "完整恢复内容、关系、来源和版本"],
    [FileText, "Markdown", "保留线性正文与标题；复杂布局降级"],
    [Download, "HTML", "保留阅读版结构与引用链接"],
    [BookOpen, "Anki", "仅导出已确认的复习卡"],
  ];
  return (
    <DrawerShell onClose={onClose} title="导出与迁移">
      <p className="text-sm leading-6 text-stone-600">导出的是当前版本的投影。不同格式会明确报告可保留与无法表达的结构。</p>
      <div className="mt-5 space-y-2">{formats.map(([Icon, title, detail]) => <button className="flex w-full items-start gap-3 rounded-[6px] border border-stone-200 p-3 text-left hover:border-stone-300 hover:bg-stone-50" key={title} type="button"><Icon aria-hidden="true" className="mt-0.5 text-stone-500" size={16} /><span><span className="block text-sm font-medium text-stone-800">{title}</span><span className="mt-0.5 block text-xs leading-5 text-stone-500">{detail}</span></span></button>)}</div>
      <button className="mt-4 inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-[6px] border border-stone-300 text-sm font-semibold text-stone-700 hover:bg-stone-50" type="button"><Upload aria-hidden="true" size={15} />导入文件并预览变更</button>
    </DrawerShell>
  );
}

function PageProperties() {
  return (
    <section aria-labelledby="page-properties-title" className="mt-7 max-w-3xl">
      <h2 className="sr-only" id="page-properties-title">页面属性</h2>
      <div className="grid gap-y-1 text-sm sm:grid-cols-[8.5rem_minmax(0,1fr)]">
        <div className="flex min-h-8 items-center gap-2 text-stone-400"><TableProperties aria-hidden="true" size={15} />状态</div><button className="flex min-h-8 w-fit items-center gap-1.5 rounded-[5px] px-2 text-left text-stone-600 hover:bg-stone-100" type="button"><span className="size-2 rounded-full bg-amber-500" />进行中</button>
        <div className="flex min-h-8 items-center gap-2 text-stone-400"><List aria-hidden="true" size={15} />标签</div><button className="flex min-h-8 w-fit items-center gap-1.5 rounded-[5px] px-2 text-left hover:bg-stone-100" type="button"><span className="rounded-[4px] bg-violet-100 px-1.5 py-0.5 text-xs font-medium text-violet-700">概率论</span><span className="rounded-[4px] bg-emerald-100 px-1.5 py-0.5 text-xs font-medium text-emerald-700">决策</span></button>
        <div className="flex min-h-8 items-center gap-2 text-stone-400"><Link2 aria-hidden="true" size={15} />来源</div><button className="flex min-h-8 w-fit items-center gap-1.5 rounded-[5px] px-2 text-left text-sky-700 hover:bg-sky-50" type="button"><Link2 aria-hidden="true" size={14} />来源锚点 · 教材第 42 页</button>
        <div className="flex min-h-8 items-center gap-2 text-stone-400"><RotateCcw aria-hidden="true" size={15} />版本</div><button className="flex min-h-8 w-fit items-center gap-1.5 rounded-[5px] px-2 text-left text-stone-600 hover:bg-stone-100" type="button">当前版本 · v12</button>
        <div className="flex min-h-8 items-center gap-2 text-stone-400"><Plus aria-hidden="true" size={15} />添加属性</div><button className="flex min-h-8 w-fit items-center rounded-[5px] px-2 text-left text-stone-400 hover:bg-stone-100 hover:text-stone-700" type="button">选择属性</button>
      </div>
    </section>
  );
}

function TitleBlock({ mode }: { mode: NotebookMode }) {
  return (
    <header>
      <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-stone-400"><span>统计学习</span><ChevronRight aria-hidden="true" size={13} /><span>概率推理</span></div>
      <button aria-label="更换页面图标" className="mt-9 grid size-16 place-items-center rounded-[8px] bg-amber-100 text-3xl transition hover:bg-amber-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500" title="更换页面图标" type="button">∑</button>
      <h1 className="mt-5 max-w-4xl text-pretty text-4xl font-semibold leading-tight text-stone-950 sm:text-5xl">概率推理：从贝叶斯公式到决策</h1>
      <PageProperties />
      <div className="mt-6 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-stone-200 pb-6 text-xs text-stone-400"><span className="grid size-5 place-items-center rounded-full bg-amber-100 text-[9px] font-semibold text-amber-800">林</span><span>最后编辑于今天 14:32</span><span className="hidden h-3 w-px bg-stone-200 sm:block" /><span>林同学</span><span className="hidden h-3 w-px bg-stone-200 sm:block" /><button className="inline-flex items-center gap-1.5 text-sky-700 hover:text-sky-900" type="button"><Link2 aria-hidden="true" size={13} />2 个来源</button></div>
      {mode === "learn" ? <div className="mt-6 flex items-center gap-3 rounded-[7px] border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950"><Sparkles aria-hidden="true" size={16} className="shrink-0 text-amber-700" /><span>学习版引用本文 14 个内容块；你的进度、作答与复习计划只对你自己可见。</span></div> : null}
    </header>
  );
}

function BlockHandle({ onInsert }: { onInsert: () => void }) {
  return (
    <div className="absolute -left-14 top-1 hidden items-center gap-0 group-hover:block lg:group-hover:flex">
      <IconButton label="插入内容块" onClick={onInsert} className="size-7"><Plus aria-hidden="true" size={15} /></IconButton>
      <IconButton label="拖动内容块" className="size-7"><GripVertical aria-hidden="true" size={15} /></IconButton>
    </div>
  );
}

function BlockRow({ children, onInsert }: { children: ReactNode; onInsert: () => void }) {
  return <section className="group relative"><BlockHandle onInsert={onInsert} />{children}</section>;
}

function FormatToolbar({ onClose }: { onClose: () => void }) {
  return (
    <div aria-label="文本格式" className="absolute left-1/2 top-1/2 z-20 flex -translate-x-1/2 -translate-y-1/2 items-center gap-0.5 rounded-[7px] border border-stone-700 bg-stone-900 p-1 shadow-xl">
      <IconButton label="加粗" className="size-8 text-stone-300 hover:bg-stone-700 hover:text-white"><Bold aria-hidden="true" size={15} /></IconButton>
      <IconButton label="斜体" className="size-8 text-stone-300 hover:bg-stone-700 hover:text-white"><Italic aria-hidden="true" size={15} /></IconButton>
      <IconButton label="添加链接" className="size-8 text-stone-300 hover:bg-stone-700 hover:text-white"><Link2 aria-hidden="true" size={15} /></IconButton>
      <span className="mx-1 h-5 w-px bg-stone-700" />
      <IconButton label="关闭格式工具栏" onClick={onClose} className="size-8 text-stone-300 hover:bg-stone-700 hover:text-white"><X aria-hidden="true" size={15} /></IconButton>
    </div>
  );
}

function BlockMenu({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const visibleOptions = blockOptions.filter((option) => `${option.label}${option.description}`.includes(query));
  const groups: BlockOption["group"][] = ["基础内容", "媒体与数据", "学习闭环"];
  return (
    <div aria-label="插入内容块" className="absolute left-0 top-11 z-30 w-[21rem] rounded-[8px] border border-stone-200 bg-white p-2 shadow-xl">
      <div className="flex items-center border-b border-stone-100 px-2 pb-2"><Search aria-hidden="true" size={15} className="text-stone-400" /><input aria-label="筛选内容块" autoComplete="off" className="ml-2 min-w-0 flex-1 bg-transparent text-sm text-stone-800 outline-none placeholder:text-stone-400" onChange={(event) => setQuery(event.target.value)} placeholder="输入 / 搜索内容块…" value={query} /></div>
      <h2 className="sr-only">插入内容块</h2>
      <div className="max-h-[26rem] overflow-y-auto py-1">
        {groups.map((group) => {
          const options = visibleOptions.filter((option) => option.group === group);
          if (options.length === 0) return null;
          return <section className="py-2" key={group}><h2 className="px-2 text-[11px] font-medium text-stone-400">{group}</h2><div className="mt-1">{options.map(({ actionName, description, icon: Icon, label }) => <button aria-label={actionName} className="flex w-full items-center gap-3 rounded-[6px] px-2 py-2 text-left hover:bg-stone-100" key={label} onClick={onClose} type="button"><span className="grid size-8 place-items-center rounded-[5px] border border-stone-200 text-stone-500"><Icon aria-hidden="true" size={16} /></span><span className="min-w-0"><span className="block text-sm font-medium text-stone-800">{label}</span><span className="block truncate text-xs text-stone-400">{description}</span></span></button>)}</div></section>;
        })}
      </div>
      <footer className="border-t border-stone-100 px-2 pt-2 text-[11px] text-stone-400">输入 <kbd className="rounded border border-stone-200 bg-stone-50 px-1">/</kbd> 随时打开此菜单</footer>
    </div>
  );
}

function ArticleContent({
  mode,
  proposalApplied,
  onOpenBlocks,
  onOpenFormat,
}: {
  mode: NotebookMode;
  proposalApplied: boolean;
  onOpenBlocks: () => void;
  onOpenFormat: () => void;
}) {
  const [expanded, setExpanded] = useState(true);
  return (
    <article className="pb-24 pt-9 text-[1.0625rem] leading-8 text-stone-700">
      <BlockRow onInsert={onOpenBlocks}><p className="text-xl leading-9 text-stone-600">贝叶斯公式不是一个替代思考的计算器。它要求我们先说清楚：原先相信什么、新证据有多可靠、以及结论要服务于什么行动。</p></BlockRow>
      <BlockRow onInsert={onOpenBlocks}><h2 className="mt-12 scroll-mt-20 text-2xl font-semibold leading-8 text-stone-950">贝叶斯公式到底在说什么</h2><p className="mt-5">当观察到证据 <span className="font-mono text-[0.96em] text-stone-950">E</span> 后，我们用它更新假设 <span className="font-mono text-[0.96em] text-stone-950">H</span> 的可信程度。关键不在于记住符号，而在于把每个符号对应到可检查的判断。</p></BlockRow>
      <BlockRow onInsert={onOpenBlocks}><div className="my-8 overflow-x-auto border-y border-stone-200 py-6 text-center font-serif text-2xl text-stone-900 sm:text-3xl">P(H | E) = <span className="italic">P</span>(E | H) <span className="italic">P</span>(H) / <span className="italic">P</span>(E)</div></BlockRow>
      <BlockRow onInsert={onOpenBlocks}><section className="my-10 border-l-2 border-sky-700 bg-sky-50/70 px-5 py-4"><div className="flex items-center gap-2 text-sm font-semibold text-sky-900"><Braces aria-hidden="true" size={16} />概念：后验概率</div><p className="mt-2 text-[0.95rem] leading-7 text-sky-950">在看见新证据之后，对假设所持有的更新信念。它既不等于证据本身，也不等于检测的准确率。</p></section></BlockRow>
      <BlockRow onInsert={onOpenBlocks}><section><button aria-expanded={expanded} className="flex w-full items-center gap-2 border-y border-stone-200 py-4 text-left text-lg font-semibold text-stone-900" onClick={() => setExpanded((value) => !value)} type="button"><ChevronDown aria-hidden="true" className={`transition-transform ${expanded ? "" : "-rotate-90"}`} size={18} />从先验到后验</button>{expanded ? <div className="pt-5"><p>先验不是主观臆测的同义词。它可以来自历史频率、此前实验、领域约束，或者一个明确标注为不确定的临时假设。新证据进入后，后验会成为下一轮推理的先验。</p><p className="mt-4">因此，可靠的推理记录应保留这条更新链，而不只展示最后的答案。</p></div> : null}</section></BlockRow>
      <BlockRow onInsert={onOpenBlocks}><section className="mt-12"><div className="flex items-start gap-3"><CircleHelp aria-hidden="true" className="mt-1 shrink-0 text-emerald-700" size={18} /><div><h2 className="scroll-mt-20 text-2xl font-semibold leading-8 text-stone-950">一个诊断测试的例子</h2><p className="mt-4">某疾病患病率为 1%。检测对病人的阳性率是 90%，对健康人的误阳性率是 5%。检测阳性后，患病的概率不是 90%，而是需要把基础患病率一并纳入计算。</p></div></div><div className="my-7 grid gap-px overflow-hidden rounded-[7px] border border-stone-200 bg-stone-200 sm:grid-cols-3">{["10000 人中约 100 人患病", "约 90 名病人呈阳性", "约 495 名健康人误报阳性"].map((stat) => <div className="bg-white p-4 text-sm leading-6 text-stone-600" key={stat}>{stat}</div>)}</div><p>所以阳性结果中，真正患病者约占 90 / (90 + 495)，不到六分之一。这个反直觉结果正是忽略先验时容易发生的误判。</p></section></BlockRow>
      <BlockRow onInsert={onOpenBlocks}><section className="mt-12 rounded-[7px] border border-rose-200 bg-rose-50 px-5 py-4"><div className="flex items-center gap-2 text-sm font-semibold text-rose-900"><X aria-hidden="true" size={16} />反例：相关性不足以更新因果结论</div><p className="mt-2 text-[0.95rem] leading-7 text-rose-950">如果证据来源与假设并不独立，或检测对象被筛选过，直接套用这组概率会产生貌似精确的错误结论。</p></section></BlockRow>
      {proposalApplied ? <BlockRow onInsert={onOpenBlocks}><section className="mt-12 rounded-[7px] border border-violet-200 bg-violet-50 p-5"><div className="flex items-center gap-2 text-sm font-semibold text-violet-950"><Sparkles aria-hidden="true" size={16} />已应用的学习版候选</div><ol className="mt-3 list-decimal space-y-1 pl-5 text-[0.95rem] leading-7 text-violet-950"><li>明确假设与先验。</li><li>检查证据的可靠性与独立性。</li><li>计算并解释后验。</li><li>用一个反例检查结论的适用范围。</li></ol></section></BlockRow> : null}
      {mode === "learn" ? <LearningPrompt /> : null}
      {mode === "edit" ? <section className="relative mt-12 border-t border-stone-100 pt-5"><button className="flex w-full items-center gap-2 rounded-[6px] px-2 py-2 text-left text-sm text-stone-400 hover:bg-stone-50 hover:text-stone-700" onClick={onOpenBlocks} type="button"><Plus aria-hidden="true" size={16} />输入 / 选择内容块</button><button className="mt-4 rounded-[5px] bg-amber-100 px-3 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-200" onClick={onOpenFormat} type="button">预览文字格式工具栏</button></section> : null}
    </article>
  );
}

function LearningPrompt() {
  const [showHint, setShowHint] = useState(false);
  return (
    <section className="mt-14 border-y-2 border-stone-900 py-8"><p className="text-xs font-semibold uppercase tracking-[0.16em] text-sky-700">回忆提示 · 独立作答</p><h2 className="mt-3 text-2xl font-semibold text-stone-950">先用自己的话回答</h2><p className="mt-3 text-stone-600">为什么“检测准确率高”不能直接推出“阳性的人大概率患病”？</p>{showHint ? <div className="mt-5 rounded-[7px] bg-stone-100 p-4 text-sm leading-6 text-stone-700">提示：把阳性者拆成两类。除了真正患病者，还要数一数健康人中有多少会误报阳性。</div> : null}<div className="mt-6 flex flex-wrap gap-3"><button className="inline-flex min-h-10 items-center gap-2 rounded-[6px] bg-stone-900 px-4 text-sm font-semibold text-white hover:bg-stone-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500" onClick={() => setShowHint((value) => !value)} type="button"><Sparkles aria-hidden="true" size={15} />{showHint ? "隐藏提示" : "显示提示"}</button><button className="inline-flex min-h-10 items-center gap-2 rounded-[6px] border border-stone-300 px-4 text-sm font-semibold text-stone-700 hover:bg-stone-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500" type="button"><PencilLine aria-hidden="true" size={15} />记录作答</button></div></section>
  );
}

export function NotebookPreview() {
  const [mode, setMode] = useState<NotebookMode>("edit");
  const [drawer, setDrawer] = useState<DrawerName>(null);
  const [width, setWidth] = useState<WidthMode>("comfortable");
  const [proposalApplied, setProposalApplied] = useState(false);
  const [canvasMenuOpen, setCanvasMenuOpen] = useState(false);
  const [popover, setPopover] = useState<PopoverName>(null);

  const widthClass = useMemo(() => ({
    comfortable: "max-w-[52rem]",
    wide: "max-w-[68rem]",
    full: "max-w-none",
  })[width], [width]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setDrawer(null);
        setCanvasMenuOpen(false);
        setPopover(null);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  function toggleDrawer(next: Exclude<DrawerName, null>) {
    setDrawer((current) => current === next ? null : next);
    setPopover(null);
  }

  function openBlocks() {
    setPopover("blocks");
    setDrawer(null);
  }

  return (
    <main className="notebook-preview scheme-light min-h-screen overflow-x-hidden bg-[#fbfbfa] text-stone-900">
      <a className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 rounded bg-white px-3 py-2 text-sm font-semibold text-sky-700 shadow" href="#notebook-page">跳到页面内容</a>
      <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-2 border-b border-stone-200 bg-white/95 px-3 backdrop-blur sm:gap-3 sm:px-5">
        <div className="flex min-w-0 items-center gap-1 sm:gap-2"><IconButton label="返回预览列表"><ArrowLeft aria-hidden="true" size={18} /></IconButton><span className="hidden text-sm font-medium text-stone-400 sm:block">笔记本预览</span><span className="hidden h-4 w-px bg-stone-200 sm:block" /><span className="hidden truncate text-sm font-semibold text-stone-700 md:block">概率推理</span></div>
        <div className="hidden sm:block"><SegmentedModes mode={mode} onChange={setMode} /></div>
        <div className="flex items-center gap-1"><span className="hidden text-xs font-medium text-emerald-700 md:block"><Check aria-hidden="true" className="mr-1 inline" size={13} />已保存</span><IconButton label="撤销" className="hidden sm:grid"><Undo2 aria-hidden="true" size={17} /></IconButton><IconButton label="重做" className="hidden sm:grid"><Redo2 aria-hidden="true" size={17} /></IconButton><button className="hidden h-9 items-center gap-1.5 rounded-[6px] bg-stone-900 px-3 text-sm font-semibold text-white hover:bg-stone-700 sm:inline-flex" onClick={() => toggleDrawer("share")} type="button"><Share2 aria-hidden="true" size={15} />分享</button><IconButton label="更多页面操作" onClick={() => toggleDrawer("export")} pressed={drawer === "export"}><MoreHorizontal aria-hidden="true" size={18} /></IconButton></div>
      </header>
      <div className="border-b border-stone-200 bg-white px-3 py-2 sm:hidden"><SegmentedModes mode={mode} onChange={setMode} /></div>

      <div className="flex min-h-[calc(100vh-3.5rem)]">
        <WorkspaceSidebar />
        <aside className="hidden w-14 shrink-0 flex-col items-center gap-2 border-r border-stone-200 bg-white py-4 xl:flex"><DrawerButton active={drawer === "outline"} icon={ListTree} label="目录" onClick={() => toggleDrawer("outline")} /><DrawerButton active={drawer === "context"} icon={PanelRightOpen} label="文档关系" onClick={() => toggleDrawer("context")} /><span className="my-1 h-px w-6 bg-stone-200" /><DrawerButton active={drawer === "ai"} icon={Bot} label="AI 助手" onClick={() => toggleDrawer("ai")} /></aside>

        <div className="min-w-0 flex-1">
          <div className="mx-auto flex h-12 items-center justify-between border-b border-stone-100 px-4 sm:px-8"><div className="flex items-center gap-2 text-xs text-stone-400"><button className="hidden items-center gap-1.5 hover:text-stone-700 sm:inline-flex" type="button"><ChevronDown aria-hidden="true" size={14} />页面</button><span className="sm:hidden">编辑空间</span></div><div className="relative"><button aria-expanded={canvasMenuOpen} className="inline-flex h-8 items-center gap-1.5 rounded-[5px] px-2 text-xs font-medium text-stone-500 hover:bg-stone-100 hover:text-stone-800" onClick={() => setCanvasMenuOpen((open) => !open)} type="button"><LayoutPanelTop aria-hidden="true" size={14} />{width === "comfortable" ? "舒适宽度" : width === "wide" ? "宽画布" : "全宽画布"}<ChevronDown aria-hidden="true" size={13} /></button>{canvasMenuOpen ? <div className="absolute right-0 top-10 z-30 w-40 rounded-[7px] border border-stone-200 bg-white p-1 shadow-lg">{(["comfortable", "wide", "full"] as WidthMode[]).map((option) => <button className={`flex w-full rounded-[5px] px-2 py-2 text-left text-xs ${width === option ? "bg-sky-50 font-medium text-sky-800" : "text-stone-600 hover:bg-stone-50"}`} key={option} onClick={() => { setWidth(option); setCanvasMenuOpen(false); }} type="button">{option === "comfortable" ? "舒适宽度" : option === "wide" ? "宽画布" : "全宽画布"}</button>)}</div> : null}</div></div>
          <div className={`relative mx-auto px-5 sm:px-10 ${widthClass}`} id="notebook-page">
            <TitleBlock mode={mode} />
            {mode === "edit" ? <div className="mt-5 flex flex-wrap items-center gap-2 border-y border-stone-100 py-3"><div className="relative"><button aria-label="插入内容块" className="inline-flex h-8 items-center gap-1.5 rounded-[5px] px-2 text-xs font-medium text-stone-600 hover:bg-stone-100" onClick={openBlocks} type="button"><Plus aria-hidden="true" size={14} />插入</button>{popover === "blocks" ? <BlockMenu onClose={() => setPopover(null)} /> : null}</div><button className="inline-flex h-8 items-center gap-1.5 rounded-[5px] px-2 text-xs font-medium text-stone-500 hover:bg-stone-100" type="button"><TableProperties aria-hidden="true" size={14} />布局</button><span className="hidden text-xs text-stone-400 sm:inline">输入 <kbd className="rounded border border-stone-200 bg-stone-50 px-1 py-0.5 font-mono">/</kbd> 添加内容块</span></div> : null}
            <ArticleContent mode={mode} proposalApplied={proposalApplied} onOpenBlocks={openBlocks} onOpenFormat={() => setPopover("format")} />
            {popover === "format" ? <FormatToolbar onClose={() => setPopover(null)} /> : null}
          </div>
        </div>

        {drawer === "outline" ? <OutlineDrawer onClose={() => setDrawer(null)} /> : null}
        {drawer === "context" ? <ContextDrawer onClose={() => setDrawer(null)} /> : null}
        {drawer === "ai" ? <AiDrawer applied={proposalApplied} onApply={() => setProposalApplied(true)} onClose={() => setDrawer(null)} /> : null}
        {drawer === "share" ? <ShareDrawer onClose={() => setDrawer(null)} /> : null}
        {drawer === "export" ? <ExportDrawer onClose={() => setDrawer(null)} /> : null}
      </div>
    </main>
  );
}
