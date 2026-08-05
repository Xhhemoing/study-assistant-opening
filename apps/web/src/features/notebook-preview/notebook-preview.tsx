"use client";

import {
  Archive,
  ArrowLeft,
  BookOpen,
  Bot,
  Braces,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Copy,
  Download,
  FileText,
  LayoutPanelTop,
  Link2,
  ListTree,
  PanelRightOpen,
  PencilLine,
  Play,
  Plus,
  Share2,
  Sparkles,
  TableProperties,
  Upload,
  WandSparkles,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

type NotebookMode = "edit" | "read" | "learn";
type DrawerName = "outline" | "context" | "ai" | "share" | "export" | null;
type WidthMode = "comfortable" | "wide" | "full";

type ModeOption = {
  id: NotebookMode;
  label: string;
  icon: typeof PencilLine;
};

type DrawerButtonProps = {
  active: boolean;
  icon: typeof ListTree;
  label: string;
  onClick: () => void;
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


function IconButton({
  label,
  children,
  onClick,
  pressed,
}: {
  label: string;
  children: ReactNode;
  onClick?: () => void;
  pressed?: boolean;
}) {
  return (
    <button
      aria-label={label}
      aria-pressed={pressed}
      className="inline-grid size-9 shrink-0 place-items-center rounded-md text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
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
      className={`inline-grid size-10 place-items-center rounded-md transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${active ? "bg-sky-50 text-sky-700" : "text-slate-500 hover:bg-slate-100 hover:text-slate-900"}`}
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
    <div aria-label="笔记模式" className="inline-flex rounded-md bg-slate-100 p-1" role="group">
      {modes.map(({ id, label, icon: Icon }) => (
        <button
          aria-pressed={mode === id}
          className={`inline-flex h-8 items-center gap-1.5 rounded px-3 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${mode === id ? "bg-white text-slate-950 shadow-sm" : "text-slate-500 hover:text-slate-800"}`}
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
    <aside aria-label={title} className="flex h-full w-[19rem] shrink-0 flex-col border-l border-slate-200 bg-white shadow-[-10px_0_28px_rgba(15,23,42,0.05)]">
      <header className="flex h-14 items-center justify-between border-b border-slate-200 px-4">
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        <IconButton label="关闭面板" onClick={onClose}><X aria-hidden="true" size={17} /></IconButton>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
    </aside>
  );
}

function OutlineDrawer({ onClose }: { onClose: () => void }) {
  return (
    <DrawerShell onClose={onClose} title="目录">
      <nav aria-label="文档目录" className="space-y-1">
        {outlineItems.map((item) => (
          <button
            className={`flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm leading-5 transition hover:bg-slate-50 ${item.depth === 1 ? "pl-6" : ""} ${item.active ? "bg-sky-50 font-medium text-sky-800" : "text-slate-600"}`}
            key={item.label}
            type="button"
          >
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-40" />
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
      <div className="mt-8 border-t border-slate-200 pt-5">
        <p className="text-xs font-medium text-slate-400">本文档</p>
        <dl className="mt-3 grid grid-cols-2 gap-y-3 text-xs">
          <div><dt className="text-slate-400">内容块</dt><dd className="mt-0.5 font-medium text-slate-700">18</dd></div>
          <div><dt className="text-slate-400">当前版本</dt><dd className="mt-0.5 font-medium text-slate-700">v12</dd></div>
          <div><dt className="text-slate-400">最后编辑</dt><dd className="mt-0.5 font-medium text-slate-700">今天 14:32</dd></div>
        </dl>
      </div>
    </DrawerShell>
  );
}

function ContextDrawer({ onClose }: { onClose: () => void }) {
  return (
    <DrawerShell onClose={onClose} title="文档关系">
      <section className="border-b border-slate-200 pb-5">
        <p className="text-xs font-medium text-slate-400">标签</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {["概率论", "决策", "统计基础"].map((tag) => <span className="rounded bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600" key={tag}>{tag}</span>)}
          <button aria-label="添加标签" className="inline-grid size-7 place-items-center rounded border border-dashed border-slate-300 text-slate-400 hover:border-slate-500 hover:text-slate-700" type="button"><Plus aria-hidden="true" size={14} /></button>
        </div>
      </section>
      <section className="border-b border-slate-200 py-5">
        <p className="text-xs font-medium text-slate-400">来源</p>
        <button className="mt-3 flex w-full items-start gap-2 rounded-md border border-slate-200 p-3 text-left hover:bg-slate-50" type="button">
          <Link2 aria-hidden="true" className="mt-0.5 shrink-0 text-sky-700" size={15} />
          <span><span className="block text-sm font-medium text-slate-700">医学检测与贝叶斯更新</span><span className="mt-1 block text-xs leading-5 text-slate-400">教材选段 · 已锚定第 42 页</span></span>
        </button>
      </section>
      <section className="pt-5">
        <p className="text-xs font-medium text-slate-400">相关笔记</p>
        <div className="mt-2 space-y-1">
          {["条件概率的语言", "独立性不是互不相关", "诊断测试的误读"].map((note) => <button className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-slate-600 hover:bg-slate-50" key={note} type="button"><FileText aria-hidden="true" size={14} className="text-slate-400" />{note}</button>)}
        </div>
      </section>
    </DrawerShell>
  );
}

function AiDrawer({ applied, onApply, onClose }: { applied: boolean; onApply: () => void; onClose: () => void }) {
  return (
    <DrawerShell onClose={onClose} title="AI 助手">
      <div className="rounded-lg border border-sky-100 bg-sky-50 p-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-sky-900"><Bot aria-hidden="true" size={16} />理解这个章节</div>
        <p className="mt-2 text-xs leading-5 text-sky-800">当前范围：第 2 节与相邻内容块。只生成候选，不会直接修改笔记。</p>
      </div>
      <div className="mt-5 space-y-2">
        <p className="text-xs font-medium text-slate-400">可生成</p>
        {["解释难点", "找出隐含前提", "制作回忆卡", "转换为学习版"].map((action) => <button className="flex w-full items-center justify-between rounded-md border border-slate-200 px-3 py-2.5 text-left text-sm text-slate-700 hover:border-slate-300 hover:bg-slate-50" key={action} type="button"><span>{action}</span><ChevronRight aria-hidden="true" size={15} className="text-slate-400" /></button>)}
      </div>
      <section className="mt-6 border-t border-slate-200 pt-5">
        <h3 className="text-xs font-medium text-slate-400">学习版候选</h3>
        <div className="mt-3 rounded-lg border border-slate-200 p-3">
          <p className="text-sm font-medium text-slate-800">从概念到练习的 4 步路径</p>
          <p className="mt-1 text-xs leading-5 text-slate-500">识别先验 · 比较证据 · 算出后验 · 检查前提</p>
          <div className="mt-3 flex items-center gap-2">
            <button className="inline-flex h-8 items-center gap-1.5 rounded bg-sky-700 px-2.5 text-xs font-semibold text-white hover:bg-sky-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500" onClick={onApply} type="button"><Copy aria-hidden="true" size={13} />{applied ? "已应用到预览" : "应用到预览"}</button>
            <button className="inline-flex h-8 items-center gap-1.5 rounded border border-slate-200 px-2.5 text-xs font-medium text-slate-600 hover:bg-slate-50" type="button"><X aria-hidden="true" size={13} />忽略</button>
          </div>
        </div>
      </section>
      <button className="mt-5 inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-md border border-sky-700 px-3 text-sm font-semibold text-sky-800 hover:bg-sky-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500" onClick={onApply} type="button"><WandSparkles aria-hidden="true" size={15} />生成学习版候选</button>
      <p className="mt-3 text-xs leading-5 text-slate-400">候选将保留来源块、版本和变更说明，需由你确认后才会进入正式内容。</p>
    </DrawerShell>
  );
}

function ShareDrawer({ onClose }: { onClose: () => void }) {
  return (
    <DrawerShell onClose={onClose} title="发布与分享">
      <div className="rounded-lg border border-slate-200 p-4">
        <p className="text-sm font-semibold text-slate-900">版本化只读发布</p>
        <p className="mt-1 text-xs leading-5 text-slate-500">读者查看固定版本；他们的练习、复习和 AI 记录不会公开。</p>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button className="inline-flex h-9 items-center justify-center rounded bg-sky-700 px-3 text-xs font-semibold text-white hover:bg-sky-800" type="button">发布 v12</button>
          <button className="inline-flex h-9 items-center justify-center rounded border border-slate-200 px-3 text-xs font-semibold text-slate-600 hover:bg-slate-50" type="button">预览读者页</button>
        </div>
      </div>
      <section className="mt-6">
        <p className="text-xs font-medium text-slate-400">读者可做什么</p>
        <div className="mt-3 space-y-3 text-sm text-slate-600">
          <label className="flex items-center justify-between gap-3"><span>查看内容与来源</span><input className="size-4 accent-sky-700" defaultChecked type="checkbox" /></label>
          <label className="flex items-center justify-between gap-3"><span>Fork 为个人副本</span><input className="size-4 accent-sky-700" defaultChecked type="checkbox" /></label>
          <label className="flex items-center justify-between gap-3"><span>下载导出文件</span><input className="size-4 accent-sky-700" type="checkbox" /></label>
        </div>
      </section>
    </DrawerShell>
  );
}

function ExportDrawer({ onClose }: { onClose: () => void }) {
  return (
    <DrawerShell onClose={onClose} title="导出与迁移">
      <p className="text-sm leading-6 text-slate-600">导出的是当前版本的投影。不同格式会明确报告可保留与无法表达的结构。</p>
      <div className="mt-5 space-y-2">
        {[
          [Archive, "AIstudy 原生包", "完整恢复内容、关系、来源和版本"],
          [FileText, "Markdown", "保留线性正文与标题；复杂布局降级"],
          [Download, "HTML", "保留阅读版结构与引用链接"],
          [BookOpen, "Anki", "仅导出已确认的复习卡"],
        ].map(([Icon, title, detail]) => {
          const ExportIcon = Icon as typeof Archive;
          return <button className="flex w-full items-start gap-3 rounded-md border border-slate-200 p-3 text-left hover:border-slate-300 hover:bg-slate-50" key={title as string} type="button"><ExportIcon aria-hidden="true" className="mt-0.5 text-slate-500" size={16} /><span><span className="block text-sm font-medium text-slate-800">{title as string}</span><span className="mt-0.5 block text-xs leading-5 text-slate-500">{detail as string}</span></span></button>;
        })}
      </div>
      <button className="mt-4 inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-md border border-slate-300 text-sm font-semibold text-slate-700 hover:bg-slate-50" type="button"><Upload aria-hidden="true" size={15} />导入文件并预览变更</button>
    </DrawerShell>
  );
}

function TitleBlock({ mode }: { mode: NotebookMode }) {
  return (
    <header className="border-b border-slate-200 pb-8">
      <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-slate-400"><span>Library</span><ChevronRight aria-hidden="true" size={13} /><span>统计学习</span><ChevronRight aria-hidden="true" size={13} /><span>贝叶斯推理</span></div>
      <h1 className="mt-6 max-w-4xl text-3xl font-semibold leading-tight text-slate-950 sm:text-4xl">概率推理：从贝叶斯公式到决策</h1>
      <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-slate-500"><span>最后编辑于今天 14:32</span><span className="hidden h-4 w-px bg-slate-200 sm:block" /><span>v12</span><span className="hidden h-4 w-px bg-slate-200 sm:block" /><button className="inline-flex items-center gap-1.5 text-sky-700 hover:text-sky-900" type="button"><Link2 aria-hidden="true" size={14} />2 个来源</button></div>
      {mode === "learn" ? <div className="mt-6 flex items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950"><Sparkles aria-hidden="true" size={16} className="shrink-0 text-amber-700" /><span>学习版引用本文 14 个内容块；你的进度、作答与复习计划只对你自己可见。</span></div> : null}
    </header>
  );
}

function ArticleContent({ mode, proposalApplied }: { mode: NotebookMode; proposalApplied: boolean }) {
  const [expanded, setExpanded] = useState(true);
  return (
    <article className="pb-20 pt-9 text-[1.0625rem] leading-8 text-slate-700">
      <section id="meaning">
        <p className="text-xl leading-9 text-slate-600">贝叶斯公式不是一个替代思考的计算器。它要求我们先说清楚：原先相信什么、新证据有多可靠、以及结论要服务于什么行动。</p>
        <h2 className="mt-12 text-2xl font-semibold leading-8 text-slate-950">贝叶斯公式到底在说什么</h2>
        <p className="mt-5">当观察到证据 <span className="font-mono text-[0.96em] text-slate-950">E</span> 后，我们用它更新假设 <span className="font-mono text-[0.96em] text-slate-950">H</span> 的可信程度。关键不在于记住符号，而在于把每个符号对应到可检查的判断。</p>
        <div className="my-8 overflow-x-auto border-y border-slate-200 py-6 text-center font-serif text-2xl text-slate-900 sm:text-3xl">P(H | E) = <span className="italic">P</span>(E | H) <span className="italic">P</span>(H) / <span className="italic">P</span>(E)</div>
      </section>

      <section className="my-10 border-l-2 border-sky-700 bg-sky-50/70 px-5 py-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-sky-900"><Braces aria-hidden="true" size={16} />概念：后验概率</div>
        <p className="mt-2 text-[0.95rem] leading-7 text-sky-950">在看见新证据之后，对假设所持有的更新信念。它既不等于证据本身，也不等于检测的准确率。</p>
      </section>

      <section>
        <button aria-expanded={expanded} className="flex w-full items-center gap-2 border-y border-slate-200 py-4 text-left text-lg font-semibold text-slate-900" onClick={() => setExpanded((value) => !value)} type="button"><ChevronDown aria-hidden="true" className={`transition-transform ${expanded ? "" : "-rotate-90"}`} size={18} />从先验到后验</button>
        {expanded ? <div className="pt-5"><p>先验不是主观臆测的同义词。它可以来自历史频率、此前实验、领域约束，或者一个明确标注为不确定的临时假设。新证据进入后，后验会成为下一轮推理的先验。</p><p className="mt-4">因此，可靠的推理记录应保留这条更新链，而不只展示最后的答案。</p></div> : null}
      </section>

      <section className="mt-12">
        <div className="flex items-start gap-3"><CircleHelp aria-hidden="true" className="mt-1 shrink-0 text-emerald-700" size={18} /><div><h2 className="text-2xl font-semibold leading-8 text-slate-950">一个诊断测试的例子</h2><p className="mt-4">某疾病患病率为 1%。检测对病人的阳性率是 90%，对健康人的误阳性率是 5%。检测阳性后，患病的概率不是 90%，而是需要把基础患病率一并纳入计算。</p></div></div>
        <div className="my-7 grid gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 sm:grid-cols-3">
          {["10000 人中约 100 人患病", "约 90 名病人呈阳性", "约 495 名健康人误报阳性"].map((stat) => <div className="bg-white p-4 text-sm leading-6 text-slate-600" key={stat}>{stat}</div>)}
        </div>
        <p>所以阳性结果中，真正患病者约占 90 / (90 + 495)，不到六分之一。这个反直觉结果正是忽略先验时容易发生的误判。</p>
      </section>

      <section className="mt-12 rounded-lg border border-rose-200 bg-rose-50 px-5 py-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-rose-900"><X aria-hidden="true" size={16} />反例：相关性不足以更新因果结论</div>
        <p className="mt-2 text-[0.95rem] leading-7 text-rose-950">如果证据来源与假设并不独立，或检测对象被筛选过，直接套用这组概率会产生貌似精确的错误结论。</p>
      </section>

      {proposalApplied ? <section className="mt-12 rounded-lg border border-violet-200 bg-violet-50 p-5"><div className="flex items-center gap-2 text-sm font-semibold text-violet-950"><Sparkles aria-hidden="true" size={16} />已应用的学习版候选</div><ol className="mt-3 list-decimal space-y-1 pl-5 text-[0.95rem] leading-7 text-violet-950"><li>明确假设与先验。</li><li>检查证据的可靠性与独立性。</li><li>计算并解释后验。</li><li>用一个反例检查结论的适用范围。</li></ol></section> : null}

      {mode === "learn" ? <LearningPrompt /> : null}
    </article>
  );
}

function LearningPrompt() {
  const [showHint, setShowHint] = useState(false);
  return (
    <section className="mt-14 border-y-2 border-slate-900 py-8">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-sky-700">回忆提示 · 独立作答</p>
      <h2 className="mt-3 text-2xl font-semibold text-slate-950">先用自己的话回答</h2>
      <p className="mt-3 text-slate-600">为什么“检测准确率高”不能直接推出“阳性的人大概率患病”？</p>
      {showHint ? <div className="mt-5 rounded-lg bg-slate-100 p-4 text-sm leading-6 text-slate-700">提示：把阳性者拆成两类。除了真正患病者，还要数一数健康人中有多少会误报阳性。</div> : null}
      <div className="mt-6 flex flex-wrap gap-3"><button className="inline-flex min-h-10 items-center gap-2 rounded-md bg-slate-900 px-4 text-sm font-semibold text-white hover:bg-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500" onClick={() => setShowHint((value) => !value)} type="button"><Sparkles aria-hidden="true" size={15} />{showHint ? "隐藏提示" : "显示提示"}</button><button className="inline-flex min-h-10 items-center gap-2 rounded-md border border-slate-300 px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500" type="button"><PencilLine aria-hidden="true" size={15} />记录作答</button></div>
    </section>
  );
}

export function NotebookPreview() {
  const [mode, setMode] = useState<NotebookMode>("edit");
  const [drawer, setDrawer] = useState<DrawerName>(null);
  const [width, setWidth] = useState<WidthMode>("comfortable");
  const [proposalApplied, setProposalApplied] = useState(false);
  const [canvasMenuOpen, setCanvasMenuOpen] = useState(false);

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
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  function toggleDrawer(next: Exclude<DrawerName, null>) {
    setDrawer((current) => current === next ? null : next);
  }

  return (
    <main className="min-h-screen bg-white text-slate-900">
      <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-3 border-b border-slate-200 bg-white/95 px-3 backdrop-blur sm:px-5">
        <div className="flex min-w-0 items-center gap-1 sm:gap-2"><IconButton label="返回预览列表"><ArrowLeft aria-hidden="true" size={18} /></IconButton><span className="hidden text-sm font-medium text-slate-400 sm:block">笔记本预览</span><span className="hidden h-4 w-px bg-slate-200 sm:block" /><span className="truncate text-sm font-semibold text-slate-700">概率推理</span></div>
        <SegmentedModes mode={mode} onChange={setMode} />
        <div className="flex items-center gap-1"><IconButton label="AI 助手" onClick={() => toggleDrawer("ai")} pressed={drawer === "ai"}><Bot aria-hidden="true" size={18} /></IconButton><IconButton label="发布与分享" onClick={() => toggleDrawer("share")} pressed={drawer === "share"}><Share2 aria-hidden="true" size={18} /></IconButton><IconButton label="导出与迁移" onClick={() => toggleDrawer("export")} pressed={drawer === "export"}><Download aria-hidden="true" size={18} /></IconButton><span className="ml-1 hidden h-4 w-px bg-slate-200 sm:block" /><span className="hidden text-xs font-medium text-emerald-700 sm:block">已保存</span></div>
      </header>

      <div className="flex min-h-[calc(100vh-3.5rem)]">
        <aside className="hidden w-14 shrink-0 flex-col items-center gap-2 border-r border-slate-200 bg-slate-50 py-4 lg:flex">
          <DrawerButton active={drawer === "outline"} icon={ListTree} label="目录" onClick={() => toggleDrawer("outline")} />
          <DrawerButton active={drawer === "context"} icon={PanelRightOpen} label="文档关系" onClick={() => toggleDrawer("context")} />
          <span className="my-1 h-px w-6 bg-slate-200" />
          <DrawerButton active={drawer === "ai"} icon={Bot} label="AI 助手" onClick={() => toggleDrawer("ai")} />
        </aside>

        <div className="min-w-0 flex-1">
          <div className="mx-auto flex h-12 items-center justify-between border-b border-slate-100 px-4 sm:px-8">
            <div className="flex items-center gap-2 text-xs text-slate-400"><span className="hidden sm:inline">专注于正文，工具按需展开</span><span className="sm:hidden">编辑空间</span></div>
            <div className="relative">
              <button aria-expanded={canvasMenuOpen} className="inline-flex h-8 items-center gap-1.5 rounded px-2 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-800" onClick={() => setCanvasMenuOpen((open) => !open)} type="button"><LayoutPanelTop aria-hidden="true" size={14} />{width === "comfortable" ? "舒适宽度" : width === "wide" ? "宽画布" : "全宽画布"}<ChevronDown aria-hidden="true" size={13} /></button>
              {canvasMenuOpen ? <div className="absolute right-0 top-10 z-30 w-40 rounded-md border border-slate-200 bg-white p-1 shadow-lg">{(["comfortable", "wide", "full"] as WidthMode[]).map((option) => <button className={`flex w-full rounded px-2 py-2 text-left text-xs ${width === option ? "bg-sky-50 font-medium text-sky-800" : "text-slate-600 hover:bg-slate-50"}`} key={option} onClick={() => { setWidth(option); setCanvasMenuOpen(false); }} type="button">{option === "comfortable" ? "舒适宽度" : option === "wide" ? "宽画布" : "全宽画布"}</button>)}</div> : null}
            </div>
          </div>
          <div className={`mx-auto px-5 sm:px-10 ${widthClass}`}>
            <TitleBlock mode={mode} />
            {mode === "edit" ? <div className="mt-5 flex flex-wrap items-center gap-2 border-y border-slate-100 py-3"><button className="inline-flex h-8 items-center gap-1.5 rounded px-2 text-xs font-medium text-slate-500 hover:bg-slate-100" type="button"><Plus aria-hidden="true" size={14} />插入</button><button className="inline-flex h-8 items-center gap-1.5 rounded px-2 text-xs font-medium text-slate-500 hover:bg-slate-100" type="button"><TableProperties aria-hidden="true" size={14} />布局</button><span className="hidden text-xs text-slate-400 sm:inline">输入 <kbd className="rounded border border-slate-200 bg-slate-50 px-1 py-0.5 font-mono">/</kbd> 添加内容块</span></div> : null}
            <ArticleContent mode={mode} proposalApplied={proposalApplied} />
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
