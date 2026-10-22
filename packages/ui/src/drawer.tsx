"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ui } from "./styles";

export type DrawerProps = {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  children: ReactNode;
  /** Keep the child React tree after first opening, including unsent input. */
  keepMounted?: boolean;
  /** Additional panel classes; responsive default is 400px / 85dvh. */
  className?: string;
  /** Replaces default body classes when a full-height workspace needs its own scrolling. */
  contentClassName?: string;
};

export function Drawer({ open, onClose, title = "详情", description, children, keepMounted = false, className = "", contentClassName = "min-h-0 flex-1 overflow-y-auto p-5" }: DrawerProps) {
  const previousFocus = useRef<HTMLElement | null>(null);
  const drag = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const [retainedHost, setRetainedHost] = useState<HTMLDivElement | null>(null);

  useEffect(() => { if (!open) drag.current = null; }, [open]);

  useEffect(() => {
    if (!keepMounted || !open || retainedHost) return;
    const host = document.createElement("div");
    host.className = "flex min-h-0 flex-1 flex-col";
    setRetainedHost(host);
  }, [keepMounted, open, retainedHost]);

  useEffect(() => {
    if (!retainedHost) return;
    retainedHost.hidden = !open;
    retainedHost.inert = !open;
    if (!open) retainedHost.remove();
  }, [open, retainedHost]);

  const retainedContent = keepMounted && retainedHost ? createPortal(children, retainedHost) : null;
  return <Dialog.Root open={open} onOpenChange={next => { if (!next) onClose(); }}>
    {/* Only the decorative frame persists for its exit transition. The modal
        itself unmounts immediately so hideOthers, focus and scrolling release. */}
    <Dialog.Portal forceMount>
      <div className="pointer-events-none fixed inset-0 z-50 overflow-hidden" aria-hidden={open ? undefined : true} inert={!open}>
        {/* Keep backdrop and frame in one portal: a newly mounted sibling
            portal would otherwise sit above the retained frame and eat clicks. */}
        {open ? <Dialog.Overlay data-drawer-backdrop="true" className="pointer-events-auto absolute inset-0 bg-black/20" /> : null}
        <div
          data-drawer-frame="true"
          data-state={open ? "open" : "closed"}
          className={`glass pointer-events-auto absolute inset-x-0 bottom-0 h-[85dvh] overflow-hidden rounded-t-[var(--radius-sheet,var(--radius-card))] text-text transition-[transform,opacity] duration-[250ms] ease-out-expo data-[state=closed]:pointer-events-none data-[state=closed]:translate-y-full data-[state=closed]:opacity-0 data-[state=closed]:duration-150 data-[state=open]:translate-y-0 data-[state=open]:opacity-100 motion-reduce:transition-none sm:inset-y-2 sm:left-auto sm:right-2 sm:h-auto sm:w-[var(--layout-side,400px)] sm:rounded-[var(--radius-panel,var(--radius-card))] sm:data-[state=closed]:translate-x-[calc(100%+16px)] sm:data-[state=closed]:translate-y-0 sm:data-[state=open]:translate-x-0 ${className}`}
        >
          {open ? <Dialog.Content
            aria-modal="true"
            className="flex h-full min-h-0 flex-col"
            onOpenAutoFocus={() => { previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
            onCloseAutoFocus={event => {
              event.preventDefault();
              if (previousFocus.current?.isConnected) previousFocus.current.focus();
            }}
          >
            <div aria-hidden="true" data-drawer-handle="true" className="flex h-7 shrink-0 touch-none select-none items-center justify-center sm:hidden"
              onPointerDown={event => {
                if (!event.isPrimary || event.button !== 0 || !["touch", "pen"].includes(event.pointerType) || !window.matchMedia?.("(max-width: 639px)").matches) return;
                event.preventDefault();
                drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
                event.currentTarget.setPointerCapture?.(event.pointerId);
              }}
              onPointerUp={event => {
                const start = drag.current;
                if (!start || start.pointerId !== event.pointerId) return;
                drag.current = null; event.preventDefault();
                const down = event.clientY - start.y, across = Math.abs(event.clientX - start.x);
                if (down >= 64 && down > across * 1.5 && window.matchMedia?.("(max-width: 639px)").matches) onClose();
              }}
              onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}>
              <span className="h-1 w-10 rounded-full bg-text-3/50" />
            </div>
            <header className="flex shrink-0 items-center justify-between gap-3 py-2 pl-5 pr-2">
              <div className="min-w-0">
                <Dialog.Title className="text-base font-semibold">{title}</Dialog.Title>
                {description ? <Dialog.Description className="text-xs text-text-2">{description}</Dialog.Description> : null}
              </div>
              <Dialog.Close asChild><button type="button" aria-label="关闭抽屉" className={ui.icon}><X aria-hidden="true" size={20} /></button></Dialog.Close>
            </header>
            {keepMounted
              ? <div className={contentClassName} ref={node => { if (node && retainedHost) { retainedHost.hidden = false; retainedHost.inert = false; node.appendChild(retainedHost); } }} />
              : <div className={contentClassName}>{children}</div>}
          </Dialog.Content> : null}
        </div>
      </div>
    </Dialog.Portal>
    {/* Never forceMount a modal: closed Radix content would keep hideOthers active. */}
    {retainedContent}
  </Dialog.Root>;
}
