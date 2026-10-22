"use client";
import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeft, ListTree, Maximize2, Minimize2, Sparkles } from "lucide-react";
import { Collapse } from "../motion/collapse";
import { runViewTransition } from "../motion/view-transition";
import { LocationLine, type LocationSegment } from "../shell/page-header";
import { TopBar, TopBarTools } from "../shell/top-bar";
import { ui } from "../ui/controls";
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
 * 布局：一个滚动区，顶栏粘顶（滚动后变玻璃）、操作条悬浮在底部（玻璃胶囊），内容从两者下面穿过。
 * 辅助区是右侧悬浮的圆角玻璃面板。
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
    <div className={`flex h-full min-h-0 gap-2 ${focus ? "fixed inset-0 z-30 bg-bg [view-transition-name:app-focus]" : ""}`}>
      <section aria-label="学习内容" hidden={replaces} className="relative flex min-w-0 flex-1 flex-col motion-safe:animate-fade-in">
        <div data-scroll-root tabIndex={0} aria-label="内容滚动区" className="flex min-h-0 flex-1 flex-col overflow-y-auto outline-offset-[-2px] [scrollbar-gutter:stable]">
          <TopBar label="学习顶栏"
            leading={onBack ? <button type="button" onClick={onBack} aria-label="返回" className={ui.icon}><ArrowLeft size={18} aria-hidden="true" /></button> : undefined}
            title={<LocationLine segments={location} />}
            actions={<>
              {progress && <span className="hidden rounded-pill px-2 text-meta tabular-nums text-text-2 sm:inline">{progress.label}</span>}
              <TopBarTools label="学习工具">
                {!focus && <button type="button" onClick={() => openCompanion("toc")} aria-pressed={showCompanion && state.tab === "toc"} className={`${ui.toolbarButton} hidden sm:inline-flex`}><ListTree size={14} aria-hidden="true" />目录</button>}
                <button type="button" onClick={toggleChat} aria-pressed={showCompanion && state.tab === "chat"}
                  className={`${ui.toolbarButton} text-text aria-pressed:bg-accent-soft aria-pressed:text-accent`}>
                  <Sparkles size={14} aria-hidden="true" />问
                </button>
                <button type="button" onClick={() => setFocus(!focus)} aria-pressed={focus} aria-label={focus ? "退出专注" : "专注"} className={ui.iconSm}>
                  {focus ? <Minimize2 size={15} aria-hidden="true" /> : <Maximize2 size={15} aria-hidden="true" />}
                </button>
              </TopBarTools>
            </>}
            progress={progress ? <ProgressSteps value={progress.current} max={progress.total} label={progress.label} /> : undefined} />

          {resumeNote && (
            <Collapse open={noteVisible}>
              <div className="content-grid pt-2">
                <div role="status" className="col-wide flex items-center justify-between gap-3 rounded-pill glass py-1 pl-4 pr-1 text-meta text-text-2">
                  <span>{resumeNote}</span>
                  <button type="button" onClick={() => setNoteVisible(false)} className={ui.toolbarButton}>知道了</button>
                </div>
              </div>
            </Collapse>
          )}

          <div className="flex-1">
            {content === "grid" ? <div className="content-grid pb-8 pt-4">{titleSlot}{children}</div> : <>{titleSlot}{children}</>}
          </div>

          {actionBar}
        </div>
      </section>

      {/* 关闭时宽度收为 0 且 inert，不卸载：对话草稿与进行中的请求不丢 */}
      <div data-open={showCompanion} data-narrow={narrow} inert={!showCompanion} aria-hidden={!showCompanion || undefined}
        className="min-w-0 overflow-hidden transition-[width,opacity,margin] duration-(--duration-panel) ease-out-expo data-[open=false]:w-0 data-[open=false]:opacity-0 data-[open=true]:w-(--layout-companion) data-[open=false]:duration-(--duration-exit) data-[open=true]:my-2 data-[open=true]:mr-2 data-[open=true]:opacity-100 data-[narrow=true]:data-[open=false]:hidden data-[narrow=true]:data-[open=true]:m-0 data-[narrow=true]:data-[open=true]:w-full data-[narrow=true]:data-[open=true]:flex-1 motion-reduce:transition-none">
        <div className={`h-full overflow-hidden ${narrow ? "w-full" : "w-(--layout-companion) rounded-panel glass"}`}>
          <CompanionPane tab={state.tab} onTabChange={tab => setState({ ...state, tab })} onClose={() => setState({ ...state, open: false })} panels={companion}
            contextSummary={narrow && contextSummary ? (
              <button type="button" onClick={() => setState({ ...state, open: false })} className="mx-3 mb-2 flex shrink-0 items-center gap-2 rounded-pill bg-text/5 px-4 py-2 text-left">
                <span className="min-w-0 flex-1 truncate text-meta text-text-2">{contextSummary}</span>
                <span className="shrink-0 text-meta font-medium text-text">回到原文</span>
              </button>
            ) : null} />
        </div>
      </div>
    </div>
  );
}
