"use client";
import { X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ui } from "./ui";

export function Inspector({ open, onClose, children, title = "学习上下文", id = "exploration-context" }: {
  open: boolean; onClose(): void; children: ReactNode; title?: string; id?: string;
}) {
  const [wide, setWide] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null), heading = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  useEffect(() => {
    const media = window.matchMedia("(min-width: 1100px)");
    const update = () => setWide(media.matches); update();
    media.addEventListener("change", update); return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => { if (previous?.isConnected) previous.focus(); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    if (!wide && !dialog.current?.open) dialog.current?.showModal();
    heading.current?.focus();
  }, [open, wide]);
  if (!open) return null;
  const body = <><header className="flex h-12 shrink-0 items-center justify-between border-b border-zinc-200 px-4">
    <h2 ref={heading} tabIndex={-1} id={titleId} className="text-xs font-semibold text-zinc-800 outline-none">{title}</h2>
    <button type="button" className={ui.icon} aria-label="关闭上下文" onClick={onClose}><X size={15} aria-hidden="true" /></button>
  </header><div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div></>;
  return wide ? <aside id={id} aria-label={title} onKeyDown={event => { if (event.key === "Escape") onClose(); }} className="flex w-72 shrink-0 flex-col border-l border-zinc-200 bg-zinc-50 transition-[opacity,transform] duration-150 motion-reduce:transition-none 2xl:w-80">{body}</aside>
    : <dialog ref={dialog} id={id} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }} className="fixed inset-y-0 right-0 left-auto m-0 h-dvh max-h-none w-[min(360px,100%)] max-w-none border-0 bg-white p-0 text-zinc-800 shadow-xl backdrop:bg-zinc-950/25 motion-reduce:transition-none"><div className="flex h-full flex-col">{body}</div></dialog>;
}
export const ResponsiveInspector = Inspector;
