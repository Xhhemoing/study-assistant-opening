"use client";
import { Dialog } from "@aistudy/ui";
import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

type SheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** 视觉隐藏标题（菜单类） */
  hideTitle?: boolean;
  children: ReactNode;
  /** dialog：桌面居中弹出，手机底部抽屉；menu：始终底部抽屉 */
  variant?: "dialog" | "menu";
  closeLabel?: string;
};

/**
 * 弹层统一入口（Radix Dialog）：焦点进入/锁定/返回、Esc、滚动锁由 Radix 负责；
 * 进出场：遮罩淡入淡出；桌面 pop / pop-out，手机 sheet-in / sheet-out。Radix 会等退场动画结束再卸载。
 */
export function Sheet({ open, onOpenChange, title, hideTitle = false, children, variant = "dialog", closeLabel = "关闭" }: SheetProps) {
  const desktop = variant === "dialog"
    ? "sm:inset-auto sm:left-1/2 sm:top-1/2 sm:w-[min(520px,calc(100vw-32px))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-sheet sm:data-[state=open]:animate-pop sm:data-[state=closed]:animate-pop-out"
    : "";
  // 触发处不一定是 Dialog.Trigger（如操作条里的按钮），自行记录并在关闭后归还焦点
  const returnTo = useRef<HTMLElement | null>(null);
  useEffect(() => { if (open) returnTo.current = document.activeElement as HTMLElement | null; }, [open]);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-ink/25 backdrop-blur-[2px] data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out" />
        <Dialog.Content aria-describedby={undefined} onCloseAutoFocus={event => { if (returnTo.current?.isConnected) { event.preventDefault(); returnTo.current.focus(); } }}
          className={`fixed inset-x-0 bottom-0 z-50 max-h-[85dvh] overflow-y-auto rounded-t-sheet glass [--glass-bg:var(--glass-bg-strong)] p-5 pb-[calc(20px+env(safe-area-inset-bottom))] text-text shadow-overlay outline-none data-[state=open]:animate-sheet-in data-[state=closed]:animate-sheet-out ${desktop}`}>
          <div className={`mb-4 flex items-center justify-between gap-3 ${hideTitle ? "sr-only" : ""}`}>
            <Dialog.Title className="text-read font-semibold">{title}</Dialog.Title>
            <Dialog.Close aria-label={closeLabel} className="grid size-(--control-h-sm) place-items-center rounded-pill text-text-3 hover:bg-text/6 hover:text-text"><X size={18} aria-hidden="true" /></Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
