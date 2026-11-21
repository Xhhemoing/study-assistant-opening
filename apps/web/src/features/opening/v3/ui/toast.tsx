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
  const scheduleDismiss = useCallback((ms = 2400) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMessage(null), ms);
  }, []);
  const notify = useCallback<Notify>(text => {
    setMessage({ id: ++seq.current, text });
    scheduleDismiss(2400);
  }, [scheduleDismiss]);
  const { mounted, state } = usePresence(Boolean(message), 140);
  const [last, setLast] = useState("");
  if (message && message.text !== last) setLast(message.text);
  return (
    <ToastContext.Provider value={useMemo(() => notify, [notify])}>
      {children}
      {/* 常驻 live region（不加 role=status，空容器不应作为页面状态被查询/朗读），内容出现时由 aria-live 播报 */}
      <div aria-live="polite" aria-atomic="true" className="pointer-events-none fixed inset-x-0 top-3 z-[60] flex justify-center px-4">
        {mounted && <p key={message?.id} data-state={state}
          onMouseEnter={() => window.clearTimeout(timer.current)}
          onMouseLeave={() => { if (message) scheduleDismiss(1600); }}
          className="pointer-events-auto rounded-pill glass px-4 py-2 text-meta font-medium text-text shadow-float data-[state=open]:motion-safe:animate-toast-in data-[state=closed]:motion-safe:animate-fade-out">{message?.text ?? last}</p>}
      </div>
    </ToastContext.Provider>
  );
}

export const useStatusToast = () => useContext(ToastContext);
