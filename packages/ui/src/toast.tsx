"use client";

import * as ToastPrimitive from "@radix-ui/react-toast";
import { Check, X } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

export type ToastMessage = { title: string; description?: string; duration?: number };
type ToastActions = { notify: (message: ToastMessage) => void; dismiss: () => void };
const ToastContext = createContext<ToastActions | null>(null);

export function Toast({ title, description, duration = 5000, open, onOpenChange }: ToastMessage & { open: boolean; onOpenChange: (open: boolean) => void }) {
  return <ToastPrimitive.Root open={open} onOpenChange={onOpenChange} duration={duration} className="keycap-ink flex items-center gap-3 rounded-[18px] px-4 py-2.5 shadow-overlay">
    <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-[10px] bg-on-ink/15"><Check size={15} aria-hidden="true" /></span>
    <div className="min-w-0 flex-1"><ToastPrimitive.Title className="text-sm font-medium leading-6">{title}</ToastPrimitive.Title>{description ? <ToastPrimitive.Description className="text-xs leading-5 opacity-85">{description}</ToastPrimitive.Description> : null}</div>
    <ToastPrimitive.Close aria-label="关闭提示" className="inline-flex size-11 shrink-0 items-center justify-center rounded-[12px] opacity-80 transition-opacity hover:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-on-ink"><X size={16} aria-hidden="true" /></ToastPrimitive.Close>
  </ToastPrimitive.Root>;
}

/** Mount once per application surface; a new message replaces the previous one. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const sequence = useRef(0);
  const [message, setMessage] = useState<(ToastMessage & { id: number }) | null>(null);
  const notify = useCallback((next: ToastMessage) => setMessage({ ...next, id: ++sequence.current }), []);
  const dismiss = useCallback(() => setMessage(null), []);
  const actions = useMemo(() => ({ notify, dismiss }), [notify, dismiss]);
  return <ToastContext.Provider value={actions}><ToastPrimitive.Provider label="提示" swipeDirection="right">
    {children}
    {message ? <Toast key={message.id} {...message} open onOpenChange={open => { if (!open) setMessage(current => current?.id === message.id ? null : current); }} /> : null}
    <ToastPrimitive.Viewport label="提示（{hotkey}）" className="fixed inset-x-4 bottom-20 z-[60] m-0 flex list-none flex-col gap-2 outline-none sm:inset-x-auto sm:bottom-5 sm:right-5 sm:w-96" />
  </ToastPrimitive.Provider></ToastContext.Provider>;
}

export function useToast(): ToastActions {
  const value = useContext(ToastContext);
  if (!value) throw new Error("useToast requires ToastProvider");
  return value;
}
