"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { PanelsTopLeft, X } from "lucide-react";
import { ui } from "../design/ui";

export type StudyToolPanel = {
  id: string;
  label: string;
  content: ReactNode;
  /** Two views of one editor can share a mounted subtree without duplicating its draft or request. */
  mountKey?: string;
};

const LAST_PANEL_KEY = "aistudy.study-tools.last-panel";
let lastPanel: string | null = null;
function rememberPanel(id: string) {
  lastPanel = id;
  try { window.localStorage.setItem(LAST_PANEL_KEY, id); } catch { /* Keep the current choice when storage is unavailable. */ }
}
function rememberedPanel(panels: StudyToolPanel[]): string | null {
  let saved = lastPanel;
  try { saved = window.localStorage.getItem(LAST_PANEL_KEY); } catch { /* Use this session's choice. */ }
  return panels.find(panel => panel.id === saved)?.id ?? panels[0]?.id ?? null;
}
type StudyToolsControl = {
  panels: StudyToolPanel[];
  activePanel: string | null;
  onPanelChange: (id: string | null) => void;
  suspended?: boolean;
};

/** The parent owns visibility; both header and inline entry reopen the same last valid tab. */
export function StudyToolsToggle({ panels, activePanel, onPanelChange, suspended = false, controlsId }: StudyToolsControl & { controlsId?: string }) {
  const open = !suspended && panels.some(panel => panel.id === activePanel);
  if (!panels.length) return null;
  return <button type="button" className={ui.quiet} aria-expanded={open} aria-controls={controlsId}
    onClick={() => onPanelChange(open ? null : rememberedPanel(panels))}><PanelsTopLeft size={16} aria-hidden="true" />工具</button>;
}

/** One auxiliary surface. Container resizing, closing and tab switches preserve visited subtrees. */
export function StudyToolsPanel({ panels, activePanel, onPanelChange, children, fillHeight = false, suspended = false, contentClassName = "", toolbarClassName = "", preferContentOnNarrowEntry = false, showToolbar = true }: {
  panels: StudyToolPanel[];
  fillHeight?: boolean;
  suspended?: boolean;
  contentClassName?: string;
  toolbarClassName?: string;
  showToolbar?: boolean;
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

  useEffect(() => { if (requested) rememberPanel(requested.id); }, [requested?.id]);

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
      if (!element || element.closest("[hidden],[inert]")) return;
      // A nested save dialog owns Escape, including its busy cancellation guard.
      if ([...document.querySelectorAll('dialog[open],[role="dialog"][data-state="open"]')].some(other => other !== element && !other.closest("[hidden],[inert]") && (element.contains(other) || !other.contains(element)))) return;
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
    {showToolbar ? <nav aria-label="学习工具" className={`mb-2 flex min-w-0 shrink-0 flex-wrap gap-1 ${toolbarClassName}`}>
      <StudyToolsToggle panels={panels} activePanel={selected?.id ?? null} onPanelChange={onPanelChange} suspended={suspended} controlsId={`${id}-companion`} />
    </nav> : null}
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
