"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { ui } from "../design/ui";

type StudyToolPanel = { id: string; label: string; content: ReactNode };

/** One auxiliary surface. Breakpoint changes and tab switches keep its drafts mounted. */
export function StudyToolsPanel({ panels, activePanel, onPanelChange, children }: {
  panels: StudyToolPanel[];
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

  return <div className="min-w-0">
    <nav aria-label="学习工具" className="mb-4 flex min-w-0 flex-wrap gap-1 border-b border-zinc-200 pb-3">
      {panels.map(panel => <button key={panel.id} type="button" className={ui.quiet}
        aria-expanded={activePanel === panel.id} aria-controls={`${id}-panel`}
        onClick={() => onPanelChange(activePanel === panel.id ? null : panel.id)}>{panel.label}</button>)}
    </nav>
    <div className={`grid min-w-0 gap-6 ${selected ? "lg:grid-cols-[minmax(0,1fr)_22rem]" : "grid-cols-1"}`}>
      <div className="min-w-0">{children}</div>
      <dialog ref={dialog} id={`${id}-panel`} aria-labelledby={`${id}-heading`}
        onCancel={event => { event.preventDefault(); onPanelChange(null); }}
        className="fixed inset-0 m-auto max-h-[90dvh] w-[calc(100%_-_1.5rem)] max-w-xl overflow-y-auto overscroll-contain rounded-xl border border-zinc-200 bg-white p-4 text-zinc-800 shadow-xl backdrop:bg-zinc-950/35 lg:static lg:m-0 lg:max-h-none lg:w-full lg:max-w-none lg:self-start lg:rounded-none lg:border-0 lg:border-l lg:pl-5 lg:pr-0 lg:pt-0 lg:shadow-none">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold" id={`${id}-heading`}>{selected?.label ?? "学习工具"}</h2>
          <button type="button" className={ui.icon} aria-label="关闭学习工具" onClick={() => onPanelChange(null)}><X size={16} aria-hidden /></button>
        </div>
        {panels.map(panel => visited.current.has(panel.id) ? <div key={panel.id} hidden={activePanel !== panel.id}>{panel.content}</div> : null)}
      </dialog>
    </div>
  </div>;
}
