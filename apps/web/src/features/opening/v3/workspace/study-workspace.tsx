"use client";
import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeft, Maximize2, Minimize2, Sparkles } from "lucide-react";
import { Collapse } from "../motion/collapse";
import { runViewTransition } from "../motion/view-transition";
import { LocationLine, type LocationSegment } from "../shell/page-header";
import { ProgressSteps } from "../ui/progress-steps";
import { CompanionPane, type CompanionTab } from "./companion-pane";

export type CompanionState = { open: boolean; tab: CompanionTab };

type StudyWorkspaceProps = {
  location: LocationSegment[];
  /** 当前对象内的真实位置，如第 3 / 5 题、第 12 / 24 页；没有就不显示进度 */
  progress?: { current: number; total: number; label: string };
  /** 重新进入未完成任务时的事实提示 */
  resumeNote?: string;
  companion: Record<CompanionTab, ReactNode>;
  actionBar?: ReactNode;
  onBack?: () => void;
  /** 可选受控：页面内「继续问」「问选中内容」从外部打开辅助区 */
  companionState?: CompanionState;
  onCompanionStateChange?: (state: CompanionState) => void;
  /** 标题承接来源列表行（共享元素过渡） */
  titleSlot?: ReactNode;
  /** 窄屏辅助区替代正文时，顶部显示的上下文摘要（如题干前一句） */
  contextSummary?: string;
  /** 内容区布局：grid（三档宽度，默认）或 bare（画布/阅读器自管宽度） */
  content?: "grid" | "bare";
  children: ReactNode;
};

/**
 * T3/T4 学习工作区：中央内容 + 右侧唯一辅助区；专注由用户主动进入。
 * 动效：辅助区宽度 0↔340 过渡、内部固定宽度不挤压；窄屏改为全宽切换并淡入；
 * 进入/退出专注用页面过渡，主区尺寸平滑变化。业务状态不因开关栏而重挂载。
 */
export function StudyWorkspace({ location, progress, resumeNote, companion, actionBar, onBack, companionState, onCompanionStateChange, titleSlot, contextSummary, content = "grid", children }: StudyWorkspaceProps) {
  const [inner, setInner] = useState<CompanionState>({ open: false, tab: "chat" });
  const state = companionState ?? inner;
  const setState = (next: CompanionState) => { if (!companionState) setInner(next); onCompanionStateChange?.(next); };
  const [focus, setFocusRaw] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const [noteVisible, setNoteVisible] = useState(Boolean(resumeNote));
  const setFocus = (next: boolean) => runViewTransition(() => setFocusRaw(next));

  useEffect(() => {
    const query = window.matchMedia("(max-width: 1023px)");
    const sync = () => setNarrow(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (!focus) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) setFocus(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focus]);

  const openCompanion = (tab: CompanionTab) => setState({ open: true, tab });
  const showCompanion = state.open && !focus;
  const replaces = showCompanion && narrow;
  const toggleChat = () => focus ? (setFocus(false), openCompanion("chat")) : state.open && state.tab === "chat" ? setState({ ...state, open: false }) : openCompanion("chat");

  return (
    <div className={`flex h-full min-h-0 ${focus ? "fixed inset-0 z-30 bg-bg [view-transition-name:app-focus]" : ""}`}>
      <section aria-label="学习内容" hidden={replaces} className="flex min-w-0 flex-1 flex-col motion-safe:animate-fade-in">
        <header className="relative flex h-11 shrink-0 items-center gap-1 border-b border-line px-2 md:px-3">
          {onBack && <button type="button" onClick={onBack} aria-label="返回" className="grid size-11 place-items-center rounded-md text-text-2 transition-colors hover:bg-surface-2"><ArrowLeft size={18} aria-hidden="true" /></button>}
          <div className="min-w-0 flex-1 px-1"><LocationLine segments={location} /></div>
          {progress && <span className="hidden px-1 text-[13px] tabular-nums text-text-2 sm:inline">{progress.label}</span>}
          {!focus && <button type="button" onClick={() => openCompanion("toc")} className="hidden h-9 rounded-md px-3 text-[13px] text-text-2 transition-colors hover:bg-surface-2 sm:inline-flex sm:items-center">目录</button>}
          <button type="button" onClick={toggleChat} aria-pressed={showCompanion && state.tab === "chat"}
            className="inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium text-text transition-colors duration-(--duration-micro) hover:bg-surface-2 aria-pressed:bg-accent-soft aria-pressed:text-accent">
            <Sparkles size={15} aria-hidden="true" />问
          </button>
          <button type="button" onClick={() => setFocus(!focus)} aria-pressed={focus} aria-label={focus ? "退出专注" : "专注"}
            className="grid size-11 place-items-center rounded-md text-text-2 transition-colors hover:bg-surface-2">
            {focus ? <Minimize2 size={16} aria-hidden="true" /> : <Maximize2 size={16} aria-hidden="true" />}
          </button>
          {progress && <div className="absolute inset-x-0 -bottom-px"><ProgressSteps value={progress.current} max={progress.total} label={progress.label} /></div>}
        </header>

        {resumeNote && (
          <Collapse open={noteVisible}>
            <div role="status" className="flex items-center justify-between gap-3 border-b border-line bg-surface-2 px-4 py-1 text-[13px] text-text-2">
              <span>{resumeNote}</span>
              <button type="button" onClick={() => setNoteVisible(false)} className="min-h-9 px-2 text-text-2 hover:text-text">知道了</button>
            </div>
          </Collapse>
        )}

        <div tabIndex={0} aria-label="内容滚动区" className="min-h-0 flex-1 overflow-y-auto outline-offset-[-2px] [scrollbar-gutter:stable]">
          {content === "grid" ? <div className="content-grid py-6">{titleSlot}{children}</div> : <>{titleSlot}{children}</>}
        </div>

        {actionBar}
      </section>

      {/* 关闭时宽度收为 0 且 inert，不卸载：对话草稿与进行中的请求不丢 */}
      <div data-open={showCompanion} data-narrow={narrow} inert={!showCompanion} aria-hidden={!showCompanion || undefined}
        className="min-w-0 overflow-hidden border-line transition-[width,opacity] duration-(--duration-panel) ease-standard data-[open=false]:w-0 data-[open=false]:opacity-0 data-[open=true]:w-(--layout-companion) data-[open=true]:border-l data-[open=false]:duration-(--duration-exit) data-[open=true]:opacity-100 data-[narrow=true]:data-[open=false]:hidden data-[narrow=true]:data-[open=true]:w-full data-[narrow=true]:data-[open=true]:flex-1 data-[narrow=true]:border-l-0 motion-reduce:transition-none">
        <div className={`h-full ${narrow ? "w-full" : "w-(--layout-companion)"}`}>
          <CompanionPane tab={state.tab} onTabChange={tab => setState({ ...state, tab })} onClose={() => setState({ ...state, open: false })} panels={companion}
            contextSummary={narrow && contextSummary ? (
              <button type="button" onClick={() => setState({ ...state, open: false })} className="flex w-full shrink-0 items-center gap-2 border-b border-line bg-surface-2 px-4 py-2 text-left">
                <span className="min-w-0 flex-1 truncate text-[13px] text-text-2">{contextSummary}</span>
                <span className="shrink-0 text-[13px] font-medium text-text">回到原文</span>
              </button>
            ) : null} />
        </div>
      </div>
    </div>
  );
}
