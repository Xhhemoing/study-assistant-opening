"use client";
import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { X } from "lucide-react";
import { runIndicatorTransition } from "../motion/view-transition";

export type CompanionTab = "chat" | "toc" | "notes";
const LABELS: Record<CompanionTab, string> = { chat: "对话", toc: "目录", notes: "笔记" };
const TABS = Object.keys(LABELS) as CompanionTab[];

type CompanionPaneProps = {
  tab: CompanionTab;
  onTabChange: (tab: CompanionTab) => void;
  onClose: () => void;
  /** 三个面板都保持挂载（hidden），切换不丢输入和滚动 */
  panels: Record<CompanionTab, ReactNode>;
  /** 窄屏时辅助区替代正文：在顶部保留当前题目/选段摘要与返回入口 */
  contextSummary?: ReactNode;
};

/** 右侧唯一辅助区：对话、目录、笔记共用一个位置。不拥有作答数据。当前标签底块滑动，新面板模糊淡入。 */
export function CompanionPane({ tab, onTabChange, onClose, panels, contextSummary }: CompanionPaneProps) {
  const base = useId();
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const list = useRef<HTMLDivElement>(null);
  const select = (next: CompanionTab) => { if (next !== tab) runIndicatorTransition(list.current, () => onTabChange(next)); };

  function onKeyDown(event: KeyboardEvent) {
    const index = TABS.indexOf(tab);
    const next =
      event.key === "ArrowRight" ? TABS[(index + 1) % TABS.length] :
      event.key === "ArrowLeft" ? TABS[(index - 1 + TABS.length) % TABS.length] :
      event.key === "Home" ? TABS[0] :
      event.key === "End" ? TABS[TABS.length - 1] : null;
    if (!next) return;
    event.preventDefault();
    select(next);
    refs.current[next]?.focus();
  }

  return (
    <aside aria-label="辅助区" className="flex h-full min-h-0 w-full flex-col bg-transparent">
      <div className="flex h-(--topbar-h) shrink-0 items-center justify-between px-2">
        <div ref={list} role="tablist" aria-label="辅助内容" className="relative flex gap-0.5 rounded-pill bg-text/5 p-0.5" onKeyDown={onKeyDown}>
          {TABS.map(key => (
            <button key={key} ref={node => { refs.current[key] = node; }}
              id={`${base}-tab-${key}`} role="tab" type="button"
              aria-selected={tab === key} aria-controls={`${base}-panel-${key}`} tabIndex={tab === key ? 0 : -1}
              onClick={() => select(key)}
              className="relative h-(--control-h-sm) rounded-pill px-3 text-meta text-text-2 transition-colors duration-(--duration-micro) hover:text-text aria-selected:font-medium aria-selected:text-text">
              {tab === key && <span data-pill aria-hidden="true" className="absolute inset-0 rounded-pill bg-surface shadow-card" />}
              <span className="relative">{LABELS[key]}</span>
            </button>
          ))}
        </div>
        <button type="button" onClick={onClose} aria-label="关闭辅助区" className="grid size-(--control-h-sm) place-items-center rounded-pill text-text-3 transition-colors hover:bg-text/6 hover:text-text">
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      {contextSummary}
      {TABS.map(key => (
        <div key={key} id={`${base}-panel-${key}`} role="tabpanel" aria-labelledby={`${base}-tab-${key}`}
          hidden={tab !== key} tabIndex={0} className="min-h-0 flex-1 overflow-y-auto motion-safe:animate-text-in">
          {panels[key]}
        </div>
      ))}
    </aside>
  );
}
