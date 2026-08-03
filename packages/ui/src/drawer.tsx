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
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
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
  }, [onClose, open]);

  if (!open) return null;
  return (
    <div ref={dialogRef} className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <button
        type="button"
        aria-label="关闭抽屉"
        data-drawer-backdrop="true"
        tabIndex={-1}
        className="absolute inset-0 bg-ink/70"
        onClick={onClose}
      />
      <aside className="relative flex h-full w-full max-w-md flex-col border-l border-line bg-surface shadow-xl">
        <header className="flex min-h-16 items-center justify-between border-b border-line px-5">
          <h2 id={titleId} className="text-base font-semibold text-text">{title}</h2>
          <button ref={closeRef} type="button" aria-label="关闭抽屉" className="inline-grid size-10 place-items-center rounded-md text-text-dim hover:bg-surface-2 hover:text-text" onClick={onClose}>
            <X aria-hidden="true" size={18} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
      </aside>
    </div>
  );
}
