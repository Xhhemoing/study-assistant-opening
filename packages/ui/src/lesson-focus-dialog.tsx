"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { Maximize2, Minimize2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ui } from "./styles";

type MoveContainer = HTMLElement & { moveBefore?: (node: Node, before: Node | null) => void };
function moveLesson(host: HTMLDivElement, target: HTMLElement) {
  if (host.parentElement === target) return;
  const destination = target as MoveContainer;
  // Atomic DOM moves also preserve embedded browsing contexts on supporting
  // browsers. Plain lessons keep their input/React state with appendChild.
  if (destination.moveBefore && host.isConnected && target.isConnected) destination.moveBefore(host, null);
  else target.appendChild(host);
}

/** One lesson tree, on the same URL, moved into a real modal and back. */
export function LessonFocusDialog({ title, children }: { title: string; children: ReactNode }) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const inline = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const element = document.createElement("div");
    element.className = "flex h-full min-h-0 min-w-0 flex-1 flex-col";
    setHost(element);
    return () => { element.remove(); };
  }, []);
  function changeOpen(next: boolean) {
    if (next && host?.querySelector("iframe") && !(inline.current as MoveContainer | null)?.moveBefore) {
      setNotice("当前浏览器无法保留嵌入内容的状态，请继续在本页学习。");
      return;
    }
    // Move back before Radix removes the modal parent, otherwise an iframe's
    // browsing context would be destroyed before the ref cleanup can move it.
    if (!next && host && inline.current) moveLesson(host, inline.current);
    setNotice(""); setOpen(next);
  }
  return <Dialog.Root open={open} onOpenChange={changeOpen}>
    <section className="flex h-full min-h-0 min-w-0 flex-col" data-lesson-focus={open ? "modal" : "inline"}>
      <div className="flex shrink-0 items-center justify-end gap-3 border-b border-line bg-surface px-5 py-2">
        {notice ? <p role="status" className="text-xs text-text-2">{notice}</p> : null}
        <Dialog.Trigger asChild><button ref={trigger} type="button" disabled={!host} className={ui.quiet}><Maximize2 size={16} aria-hidden="true" />专注学习</button></Dialog.Trigger>
      </div>
      <div className="min-h-0 min-w-0 flex-1" ref={node => {
        inline.current = node;
        if (node && host && !open) moveLesson(host, node);
      }}>
        {!host ? <p role="status" className="p-5 text-sm text-text-2">正在准备学习台…</p> : null}
      </div>
    </section>
    <Dialog.Portal forceMount>
      <div className="pointer-events-none fixed inset-0 z-50 overflow-hidden" aria-hidden={open ? undefined : true} inert={!open}>
        {open ? <Dialog.Overlay className="pointer-events-auto absolute inset-0 bg-black/30" /> : null}
        <div data-lesson-focus-frame="true" data-state={open ? "open" : "closed"} className="absolute inset-0 bg-surface text-text transition-[transform,opacity] duration-[220ms] ease-out-expo data-[state=open]:pointer-events-auto data-[state=open]:scale-100 data-[state=open]:opacity-100 data-[state=closed]:pointer-events-none data-[state=closed]:scale-[0.99] data-[state=closed]:opacity-0 motion-reduce:transition-none sm:inset-5 sm:rounded-card sm:border sm:border-line sm:shadow-overlay">
          {open ? <Dialog.Content className="flex h-full min-h-0 min-w-0 flex-col" aria-describedby={undefined} onCloseAutoFocus={event => {
            event.preventDefault(); trigger.current?.focus({ preventScroll: true });
          }}>
            <header className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-5 py-3">
              <Dialog.Title className="min-w-0 break-words font-serif text-lg font-medium">{title}</Dialog.Title>
              <Dialog.Close asChild><button type="button" className={`${ui.quiet} shrink-0`}><Minimize2 size={16} aria-hidden="true" />退出专注</button></Dialog.Close>
            </header>
            <div className="min-h-0 min-w-0 flex-1" ref={node => {
              if (!host) return;
              if (node) moveLesson(host, node);
              else if (inline.current) moveLesson(host, inline.current);
            }} />
          </Dialog.Content> : null}
        </div>
      </div>
    </Dialog.Portal>
    {host ? createPortal(children, host) : null}
  </Dialog.Root>;
}
