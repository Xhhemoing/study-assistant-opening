"use client";

import { X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { getFocusTrapTarget } from "./focus-trap-model";

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>("button, [href], input, select, textarea, [tabindex]")).filter(
    (element) => !element.hasAttribute("disabled") && element.tabIndex >= 0,
  );
}

export function Drawer({
  open,
  onClose,
  title = "详情",
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
}) {
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onCloseRef.current(); }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const elements = focusableElements(dialogRef.current);
      if (elements.length === 0) return;
      const activeIndex = elements.indexOf(document.activeElement as HTMLElement);
      const targetIndex = getFocusTrapTarget(activeIndex, event.shiftKey ? "backward" : "forward", elements.length);
      if (targetIndex !== null) {
        event.preventDefault();
        elements[targetIndex]?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    closeRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (previousFocusRef.current && document.contains(previousFocusRef.current)) previousFocusRef.current.focus();
      previousFocusRef.current = null;
    };
  }, [open]);

  if (!open) return null;
  return (
    <div ref={dialogRef} className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <button
        type="button"
        aria-label="关闭抽屉"
        data-drawer-backdrop="true"
        tabIndex={-1}
        className="absolute inset-0 bg-zinc-950/30"
        onClick={onClose}
      />
      <aside className="relative flex h-full w-full max-w-80 flex-col border-l border-zinc-200 bg-white shadow-xl">
        <header className="flex min-h-12 items-center justify-between border-b border-zinc-200 px-5">
          <h2 id={titleId} className="text-sm font-semibold text-zinc-800">{title}</h2>
          <button ref={closeRef} type="button" aria-label="关闭抽屉" className="inline-grid size-10 place-items-center rounded-md text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 md:size-8" onClick={onClose}>
            <X aria-hidden="true" size={18} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
      </aside>
    </div>
  );
}
