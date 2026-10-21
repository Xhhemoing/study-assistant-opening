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
  const [retainedHost, setRetainedHost] = useState<HTMLDivElement | null>(null);

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
    <Dialog.Portal>
      <Dialog.Overlay data-drawer-backdrop="true" className="fixed inset-0 z-50 bg-black/30" />
      <Dialog.Content
        aria-modal="true"
        className={`fixed inset-x-0 bottom-0 z-50 flex h-[85dvh] flex-col rounded-t-card border border-line bg-surface text-text shadow-overlay sm:inset-y-0 sm:left-auto sm:right-0 sm:h-dvh sm:w-[400px] sm:rounded-none ${className}`}
        onOpenAutoFocus={() => { previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
        onCloseAutoFocus={event => {
          event.preventDefault();
          if (previousFocus.current?.isConnected) previousFocus.current.focus();
        }}
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-5 py-3">
          <div className="min-w-0">
            <Dialog.Title className="font-serif text-xl font-medium leading-7">{title}</Dialog.Title>
            {description ? <Dialog.Description className="mt-1 text-sm leading-6 text-text-2">{description}</Dialog.Description> : null}
          </div>
          <Dialog.Close asChild><button type="button" aria-label="关闭抽屉" className={ui.icon}><X aria-hidden="true" size={20} /></button></Dialog.Close>
        </header>
        {keepMounted
          ? <div className={contentClassName} ref={node => { if (node && retainedHost) { retainedHost.hidden = false; retainedHost.inert = false; node.appendChild(retainedHost); } }} />
          : <div className={contentClassName}>{children}</div>}
      </Dialog.Content>
    </Dialog.Portal>
    {/* Never forceMount a modal: closed Radix content would keep hideOthers active. */}
    {retainedContent}
  </Dialog.Root>;
}
