"use client";
import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { X } from "lucide-react";

export type CompanionTab = "chat" | "toc" | "notes";
const LABELS: Record<CompanionTab, string> = { chat: "对话", toc: "目录", notes: "笔记" };
const TABS = Object.keys(LABELS) as CompanionTab[];

type CompanionPaneProps = {
  tab: CompanionTab;
  onTabChange: (tab: CompanionTab) => void;
  onClose: () => void;
  /** 三个面板都保持挂载（hidden），切换不丢输入和滚动 */
  panels: Record<CompanionTab, ReactNode>;
};

/** 右侧唯一辅助区：对话、目录、笔记共用一个位置。不拥有作答数据。切换时新面板淡入。 */
export function CompanionPane({ tab, onTabChange, onClose, panels }: CompanionPaneProps) {
  const base = useId();
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  function onKeyDown(event: KeyboardEvent) {
    const index = TABS.indexOf(tab);
    const next =
      event.key === "ArrowRight" ? TABS[(index + 1) % TABS.length] :
      event.key === "ArrowLeft" ? TABS[(index - 1 + TABS.length) % TABS.length] :
      event.key === "Home" ? TABS[0] :
      event.key === "End" ? TABS[TABS.length - 1] : null;
    if (!next) return;
    event.preventDefault();
    onTabChange(next);
    refs.current[next]?.focus();
  }

  return (
    <aside aria-label="辅助区" className="flex h-full min-h-0 w-full flex-col bg-surface">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-line px-2">
        <div role="tablist" aria-label="辅助内容" className="relative flex gap-1" onKeyDown={onKeyDown}>
          {TABS.map(key => (
            <button key={key} ref={node => { refs.current[key] = node; }}
              id={`${base}-tab-${key}`} role="tab" type="button"
              aria-selected={tab === key} aria-controls={`${base}-panel-${key}`} tabIndex={tab === key ? 0 : -1}
              onClick={() => onTabChange(key)}
              className="relative h-8 rounded-sm px-3 text-[13px] text-text-2 transition-colors duration-(--duration-micro) hover:text-text aria-selected:font-medium aria-selected:text-text">
              {tab === key && <span aria-hidden="true" className="absolute inset-0 rounded-sm bg-surface-2 motion-safe:animate-fade-in" />}
              <span className="relative">{LABELS[key]}</span>
            </button>
          ))}
        </div>
        <button type="button" onClick={onClose} aria-label="关闭辅助区" className="grid size-9 place-items-center rounded-sm text-text-3 transition-colors hover:bg-surface-2 hover:text-text">
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      {TABS.map(key => (
        <div key={key} id={`${base}-panel-${key}`} role="tabpanel" aria-labelledby={`${base}-tab-${key}`}
          hidden={tab !== key} tabIndex={0} className="min-h-0 flex-1 overflow-y-auto motion-safe:animate-fade-in">
          {panels[key]}
        </div>
      ))}
    </aside>
  );
}
