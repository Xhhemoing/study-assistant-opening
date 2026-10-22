"use client";
import type { ReactNode } from "react";
import { ArrowLeft, PanelRight, SquarePen } from "lucide-react";
import { TransitionLink } from "../motion/view-transition";
import { TopBar, TopBarTools } from "../shell/top-bar";
import { ui } from "../ui/controls";

type ConversationLayoutProps = {
  title: string;
  backHref: string;
  newHref: string;
  /** 右侧面板是否打开、切换；面板本体（SidePanel）由页面传入 side */
  sideOpen: boolean;
  onToggleSide: () => void;
  side: ReactNode;
  /** 手机右上工具（搜索、更多） */
  tools?: ReactNode;
  children: ReactNode;
};

/**
 * 对话页：顶栏（返回、标题、工具胶囊：右侧面板 / 新对话）+ 对话 + 右侧面板。
 * 回答里的对象卡（题目、资料）默认在右侧打开，不离开对话；面板里可再进入完整页面。
 */
export function ConversationLayout({ title, backHref, newHref, sideOpen, onToggleSide, side, tools, children }: ConversationLayoutProps) {
  return (
    <div className="flex h-full min-h-0">
      <div data-scroll-root className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        <TopBar label="对话顶栏"
          leading={<TransitionLink href={backHref} direction="back" aria-label="全部对话" className={`${ui.icon} md:hidden`}><ArrowLeft size={18} aria-hidden="true" /></TransitionLink>}
          title={<h1 className="truncate text-ui font-medium text-text">{title}</h1>}
          actions={<>
            <TopBarTools label="对话工具">
              <button type="button" onClick={onToggleSide} aria-pressed={sideOpen} className={`${ui.toolbarButton} hidden lg:inline-flex`}><PanelRight size={14} aria-hidden="true" />右侧</button>
              <TransitionLink href={newHref} aria-label="新对话" className={ui.iconSm}><SquarePen size={15} aria-hidden="true" /></TransitionLink>
            </TopBarTools>
            {tools}
          </>} />
        <div className="min-h-0 flex-1">{children}</div>
      </div>
      {side}
    </div>
  );
}
