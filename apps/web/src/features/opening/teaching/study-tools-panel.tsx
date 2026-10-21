"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { ui } from "../design/ui";

type StudyToolPanel = { id: string; label: string; content: ReactNode };

/** One auxiliary surface. Breakpoint changes and tab switches keep its drafts mounted. */
export function StudyToolsPanel({ panels, activePanel, onPanelChange, children, fillHeight = false }: {
  panels: StudyToolPanel[];
  fillHeight?: boolean;
  activePanel: string | null;
  onPanelChange: (id: string | null) => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const visited = useRef(new Set<string>());
  const [wide, setWide] = useState(false);
  const id = useId();
  const selected = panels.find(panel => panel.id === activePanel);
  if (selected) visited.current.add(selected.id);

  useEffect(() => {
    const query = window.matchMedia("(min-width: 1024px)");
    const update = () => setWide(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (!selected) {
      if (element.open) element.close();
      if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
      opener.current = null;
      return;
    }
    if (!opener.current) opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // A native dialog must be closed before switching between modal and non-modal.
    if (element.open && element.hasAttribute("data-modal") !== !wide) element.close();
    element.toggleAttribute("data-modal", !wide);
    if (!element.open) {
      if (wide) element.show();
      else element.showModal();
    }
  }, [selected?.id, wide]);
  useEffect(() => {
    const element = dialog.current;
    return () => { element?.close(); };
  }, []);
  useEffect(() => {
    if (!selected || !wide) return;
    function escape(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // A reader can itself be modal. Its own side tools close first; a modal
      // opened above another workspace keeps ownership of Escape instead.
      const element = dialog.current;
      if (!element || [...document.querySelectorAll("dialog:modal")].some(modal => !modal.contains(element))) return;
      event.preventDefault();
      onPanelChange(null);
    }
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [selected?.id, wide, onPanelChange]);

  return <div className={fillHeight ? "flex h-full min-h-0 min-w-0 flex-col" : "min-w-0"}>
    <nav aria-label="学习工具" className="mb-2 flex min-w-0 shrink-0 flex-wrap gap-1 border-b border-line pb-1">
      {panels.map(panel => <button key={panel.id} type="button" className={ui.quiet}
        aria-expanded={activePanel === panel.id} aria-controls={`${id}-panel`}
        onClick={() => onPanelChange(activePanel === panel.id ? null : panel.id)}>{panel.label}</button>)}
    </nav>
    <div className={`grid min-w-0 gap-4 ${fillHeight ? "min-h-0 flex-1 grid-rows-[minmax(0,1fr)]" : ""} ${selected ? "lg:grid-cols-[minmax(0,1fr)_22rem]" : "grid-cols-1"}`}>
      <div className={fillHeight ? "flex min-h-0 min-w-0 flex-col overflow-y-auto overscroll-contain" : "min-w-0"}>{children}</div>
      <dialog ref={dialog} id={`${id}-panel`} aria-labelledby={`${id}-heading`}
        onCancel={event => { if (event.target !== event.currentTarget) return; event.preventDefault(); onPanelChange(null); }}
        className={`fixed inset-0 m-auto max-h-[90dvh] w-[calc(100%_-_1.5rem)] max-w-xl ${fillHeight ? "overflow-hidden" : "overflow-y-auto"} overscroll-contain rounded-xl border border-line bg-surface p-4 text-text shadow-xl backdrop:bg-ink/35 lg:static lg:m-0 lg:max-h-none lg:w-full lg:max-w-none lg:self-start lg:rounded-none lg:border-0 lg:border-l lg:pl-5 lg:pr-0 lg:pt-0 lg:shadow-none ${fillHeight ? "h-[90dvh] min-h-0 open:flex open:flex-col lg:h-full lg:self-stretch" : ""}`}>
        <div className="mb-3 flex shrink-0 items-center justify-between gap-3">
          <h2 className="text-sm font-semibold" id={`${id}-heading`}>{selected?.label ?? "学习工具"}</h2>
          <button type="button" className={ui.icon} aria-label="关闭学习工具" onClick={() => onPanelChange(null)}><X size={16} aria-hidden /></button>
        </div>
        {panels.map(panel => visited.current.has(panel.id) ? <div key={panel.id} hidden={activePanel !== panel.id} className={activePanel !== panel.id ? "hidden" : fillHeight ? "min-h-0 flex-1 overflow-y-auto overscroll-contain" : ""}>{panel.content}</div> : null)}
      </dialog>
    </div>
  </div>;
}
