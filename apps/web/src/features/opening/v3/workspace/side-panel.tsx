"use client";
import { useEffect, useState, type ReactNode } from "react";
import { Maximize2, Minimize2, X } from "lucide-react";
import { ui } from "../ui/controls";
import { Sheet } from "../ui/sheet";

type SidePanelProps = {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** 面板顶部右侧的额外操作（如「在学习页打开」） */
  actions?: ReactNode;
  /** md 400px / lg 560px，由用户切换并记住 */
  size: "md" | "lg";
  onSizeChange: (size: "md" | "lg") => void;
  children: ReactNode;
  label?: string;
};

/**
 * 右侧打开（对话页等）：桌面为右侧悬浮的圆角玻璃面板，宽度过渡、关闭时不卸载内容；
 * 窄屏（<1024px）改为底部抽屉。焦点：打开时不抢输入框焦点，Esc 关闭。
 */
export function SidePanel({ open, onClose, title, actions, size, onSizeChange, children, label = "右侧面板" }: SidePanelProps) {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 1023px)");
    const sync = () => setNarrow(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  useEffect(() => {
    if (!open || narrow) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, narrow, onClose]);

  if (narrow) return <Sheet open={open} onOpenChange={next => { if (!next) onClose(); }} title={typeof title === "string" ? title : label} variant="menu">{children}</Sheet>;

  const header = (
    <div className="flex h-(--topbar-h) shrink-0 items-center gap-1 pl-4 pr-1.5">
      <div className="min-w-0 flex-1 truncate text-ui font-medium text-text">{title}</div>
      {actions}
      <button type="button" className={ui.iconSm} onClick={() => onSizeChange(size === "md" ? "lg" : "md")} aria-label={size === "md" ? "加宽面板" : "收窄面板"}>
        {size === "md" ? <Maximize2 size={14} aria-hidden="true" /> : <Minimize2 size={14} aria-hidden="true" />}
      </button>
      <button type="button" className={ui.iconSm} onClick={onClose} aria-label="关闭右侧面板"><X size={15} aria-hidden="true" /></button>
    </div>
  );
  return (
    <div data-open={open} data-size={size} inert={!open} aria-hidden={!open || undefined}
      className="shrink-0 overflow-hidden transition-[width,opacity,margin] duration-(--duration-panel) ease-out-expo data-[open=false]:w-0 data-[open=false]:opacity-0 data-[open=false]:duration-(--duration-exit) data-[open=true]:my-2 data-[open=true]:mr-2 data-[open=true]:opacity-100 data-[size=lg]:data-[open=true]:w-(--layout-side-wide) data-[size=md]:data-[open=true]:w-(--layout-side) motion-reduce:transition-none">
      <aside aria-label={label} className={`flex h-full flex-col overflow-hidden rounded-panel glass ${size === "lg" ? "w-(--layout-side-wide)" : "w-(--layout-side)"}`}>
        {header}
        <div key={size} className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 motion-safe:animate-text-in">{children}</div>
      </aside>
    </div>
  );
}
