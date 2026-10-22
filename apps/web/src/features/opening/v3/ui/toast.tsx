"use client";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { usePresence } from "../motion/use-presence";

type Notify = (text: string) => void;
const ToastContext = createContext<Notify>(() => undefined);

/**
 * 轻提示：顶部居中、弹簧进入、淡出；新消息替换旧消息；role=status。
 * 仓库已有 @aistudy/ui ToastProvider（底部、可关闭）用于需要操作的提示；这里只用于「已保存」类确认。
 */
export function StatusToastProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<{ id: number; text: string } | null>(null);
  const seq = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  const notify = useCallback<Notify>(text => {
    window.clearTimeout(timer.current);
    setMessage({ id: ++seq.current, text });
    timer.current = window.setTimeout(() => setMessage(null), 2400);
  }, []);
  const { mounted, state } = usePresence(Boolean(message), 140);
  const [last, setLast] = useState("");
  if (message && message.text !== last) setLast(message.text);
  return (
    <ToastContext.Provider value={useMemo(() => notify, [notify])}>
      {children}
      <div role="status" aria-live="polite" className="pointer-events-none fixed inset-x-0 top-3 z-[60] flex justify-center px-4">
        {mounted && <p key={message?.id} data-state={state}
          className="rounded-pill bg-ink px-4 py-2 text-[13px] text-on-ink shadow-float data-[state=open]:motion-safe:animate-toast-in data-[state=closed]:motion-safe:animate-fade-out">{message?.text ?? last}</p>}
      </div>
    </ToastContext.Provider>
  );
}

export const useStatusToast = () => useContext(ToastContext);
