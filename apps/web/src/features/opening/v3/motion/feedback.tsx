"use client";
import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

/**
 * 原地换字（text states swap）：值变化时新文字带 2px 模糊上浮进入。
 * 用于状态文字、计数、保存状态；不用于正文。
 */
export function TextSwap({ value, children, className = "" }: { value: string | number; children?: ReactNode; className?: string }) {
  return <span key={value} className={`inline-block motion-safe:animate-text-in ${className}`}>{children ?? value}</span>;
}

/**
 * AI 进行中的状态行（thinking states）：文字上流光；label 变化时原地换字。
 * label 只能来自服务端真实阶段（已接收、识别图片、批改中…），前端不编造进度。
 */
export function ThinkingLine({ label }: { label: string }) {
  return (
    <span role="status" className="inline-flex items-center gap-2">
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-pill bg-ai-2 motion-safe:animate-breathe" />
      <TextSwap value={label} className="bg-linear-to-r from-text-2 via-text to-text-2 bg-[length:200%_100%] bg-clip-text text-transparent motion-safe:animate-shimmer-text motion-reduce:text-text-2">{label}</TextSwap>
    </span>
  );
}

/** 确认时刻的勾号（success check）：模糊 + 旋转 + 轻弹进入，路径随后描边。play=false 时静态显示（恢复状态不播放）。 */
export function SuccessCheck({ play, size = 16, label = "正确" }: { play: boolean; size?: number; label?: string }) {
  return (
    <span role={label ? "img" : undefined} aria-label={label || undefined} aria-hidden={label ? undefined : true} className={`inline-grid shrink-0 place-items-center text-accent ${play ? "motion-safe:animate-check-in" : ""}`}>
      <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" className="overflow-visible">
        <path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="24" className={play ? "motion-safe:animate-draw" : ""} />
      </svg>
    </span>
  );
}

/**
 * 让同一个动画在 trigger 变化时重播（错误抖动等）：先移除再在下一帧加回，不重挂载元素、不丢焦点。
 */
export function useReplay(trigger: number): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!trigger) return;
    setOn(false);
    let inner = 0;
    const outer = requestAnimationFrame(() => { inner = requestAnimationFrame(() => setOn(true)); });
    return () => { cancelAnimationFrame(outer); cancelAnimationFrame(inner); };
  }, [trigger]);
  return on;
}

/** 展开按钮上的箭头：垂直翻转（scaleY），各浏览器一致。 */
export function DisclosureChevron({ open }: { open: boolean }) {
  return <ChevronDown size={14} aria-hidden="true" data-open={open} className="shrink-0 transition-transform duration-(--duration-enter) ease-out-expo data-[open=true]:-scale-y-100" />;
}
