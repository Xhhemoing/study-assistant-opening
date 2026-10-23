"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { X } from "lucide-react";
import { ui } from "../design/ui";

export type StudyToolPanel = {
  id: string;
  label: string;
  content: ReactNode;
  /** Two views of one editor can share a mounted subtree without duplicating its draft or request. */
  mountKey?: string;
};

/** One auxiliary surface. Container resizing, closing and tab switches preserve visited subtrees. */
export function StudyToolsPanel({ panels, activePanel, onPanelChange, children, fillHeight = false, suspended = false, contentClassName = "", toolbarClassName = "", preferContentOnNarrowEntry = false }: {
  panels: StudyToolPanel[];
  fillHeight?: boolean;
  suspended?: boolean;
  contentClassName?: string;
  toolbarClassName?: string;
  /** Only the initial automatic companion opening yields to task content on narrow screens. */
  preferContentOnNarrowEntry?: boolean;
  activePanel: string | null;
  onPanelChange: (id: string | null) => void;
  children: ReactNode;
}) {
  const container = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const visited = useRef(new Set<string>());
  const [wide, setWide] = useState(false);
  const [measured, setMeasured] = useState(false);
  const [entryReady, setEntryReady] = useState(!preferContentOnNarrowEntry);
  const entryHandled = useRef(false);
  const id = useId();
  const requested = panels.find(panel => panel.id === activePanel);
  const selected = suspended || (!entryReady && !wide) ? undefined : requested;
  const selectedKey = selected?.mountKey ?? selected?.id;
  const mountKeys = [...new Set(panels.map(panel => panel.mountKey ?? panel.id))];
  const requestedKey = requested?.mountKey ?? requested?.id;
  if (requestedKey) visited.current.add(requestedKey);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    // This is the actual workspace width after navigation, not the viewport breakpoint.
    const updateWidth = (width: number) => { setWide(width >= 1024); setMeasured(true); };
    const measure = () => updateWidth(element.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(entries => {
        const entry = entries.find(item => item.target === element);
        if (entry) updateWidth(entry.contentRect.width);
      });
      observer.observe(element);
      return () => observer.disconnect();
    }
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  useEffect(() => {
    if (!measured || entryHandled.current) return;
    entryHandled.current = true;
    if (preferContentOnNarrowEntry && !wide && requested) onPanelChange(null);
    setEntryReady(true);
  }, [measured, wide, preferContentOnNarrowEntry, requested?.id, onPanelChange]);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (!selected) {
      const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (element.open) element.close();
      if (suspended && focused?.isConnected && !element.contains(focused)) focused.focus({ preventScroll: true });
      if (!suspended && opener.current?.isConnected) opener.current.focus({ preventScroll: true });
      opener.current = null;
      return;
    }
    if (!element.open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      // A non-modal dialog remains in the same grid on both layouts. Narrow screens
      // switch the content surface rather than adding a second modal/scroll layer.
      element.show();
      if (wide && opener.current?.isConnected) opener.current.focus({ preventScroll: true });
    }
    if (!wide && content.current?.contains(document.activeElement)) {
      element.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true });
    }
  }, [selected?.id, wide, suspended]);

  useEffect(() => {
    const element = dialog.current;
    return () => { element?.close(); };
  }, []);

  useEffect(() => {
    if (!selected) return;
    function escape(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      const element = dialog.current;
      if (!element) return;
      // A nested save dialog owns Escape, including its busy cancellation guard.
      if ([...document.querySelectorAll("dialog[open]")].some(other => other !== element && (element.contains(other) || !other.contains(element)))) return;
      event.preventDefault();
      onPanelChange(null);
    }
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [selected?.id, onPanelChange]);

  function navigateTab(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    const next = event.key === "ArrowRight" ? (index + 1) % panels.length
      : event.key === "ArrowLeft" ? (index + panels.length - 1) % panels.length
      : event.key === "Home" ? 0 : event.key === "End" ? panels.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    onPanelChange(panels[next]!.id);
    document.getElementById(`${id}-tab-${panels[next]!.id}`)?.focus({ preventScroll: true });
  }

  return <div ref={container} className={`flex min-w-0 flex-col ${fillHeight ? "h-full min-h-0" : ""}`} data-study-tools-layout={wide ? "split" : "switch"}>
    <nav aria-label="学习工具" className={`mb-2 flex min-w-0 shrink-0 flex-wrap gap-1 ${toolbarClassName}`}>
      {panels.map(panel => <button key={panel.id} type="button" className={ui.quiet}
        aria-expanded={selected?.id === panel.id} aria-controls={`${id}-companion`}
        onClick={() => onPanelChange(selected?.id === panel.id ? null : panel.id)}>{panel.label}</button>)}
    </nav>
    <div className={`grid min-w-0 ${fillHeight ? "min-h-0 flex-1 grid-rows-[minmax(0,1fr)]" : ""} ${selected && wide ? "grid-cols-[minmax(0,1fr)_340px]" : "grid-cols-1"}`}>
      <div ref={content} hidden={Boolean(selected && !wide)} className={selected && !wide ? "hidden" : `min-w-0 ${contentClassName} ${fillHeight ? "min-h-0 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]" : ""}`} data-study-content="true">{children}</div>
      <dialog ref={dialog} data-study-companion="true" id={`${id}-companion`} aria-label="学习辅助区"
        onCancel={event => { if (event.target !== event.currentTarget) return; event.preventDefault(); onPanelChange(null); }}
        className={`static m-0 hidden min-h-0 w-full min-w-0 max-w-none flex-col overflow-hidden border-0 bg-surface p-0 text-text open:flex ${wide ? "border-l border-line pl-4" : ""} ${fillHeight ? "h-full" : ""}`}>
        <div className="mb-3 flex shrink-0 items-start justify-between gap-1">
          <div role="tablist" aria-label="学习辅助区" className="flex min-w-0 flex-wrap gap-1">
            {panels.map((panel, index) => <button key={panel.id} id={`${id}-tab-${panel.id}`} type="button" role="tab"
              aria-selected={selected?.id === panel.id} aria-controls={`${id}-panel-${panel.mountKey ?? panel.id}`}
              tabIndex={selected?.id === panel.id ? 0 : -1}
              className={`${ui.quiet} ${selected?.id === panel.id ? "bg-surface-2 font-semibold text-text" : ""}`}
              onKeyDown={event => navigateTab(event, index)} onClick={() => onPanelChange(panel.id)}>{panel.label}</button>)}
          </div>
          <button type="button" className={`${ui.icon} shrink-0`} aria-label="关闭学习工具" onClick={() => onPanelChange(null)}><X size={16} aria-hidden /></button>
        </div>
        {mountKeys.map(key => {
          const panel = panels.find(item => (item.mountKey ?? item.id) === key && item.id === selected?.id)
            ?? panels.find(item => (item.mountKey ?? item.id) === key)!;
          const visible = selectedKey === key;
          return <div key={key} role="tabpanel" id={`${id}-panel-${key}`} aria-labelledby={`${id}-tab-${panel.id}`}
            hidden={!visible} tabIndex={0} className={visible ? `min-h-0 min-w-0 ${fillHeight ? "flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]" : ""}` : "hidden"}>
            {visited.current.has(key) ? panel.content : null}
          </div>;
        })}
      </dialog>
    </div>
  </div>;
}
