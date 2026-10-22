"use client";
import { useEffect, useState, type RefObject } from "react";
import { createPortal } from "react-dom";

export type TextSelection = { text: string; block: HTMLElement; page?: number };

/**
 * 监听容器内的文字选择，返回选区与所在块（带 data-select-block 的元素）。
 * 不计算屏幕坐标：浮层渲染进所在块内部，由块自身定位，滚动与缩放天然跟随。
 */
export function useTextSelection(container: RefObject<HTMLElement | null>): [TextSelection | null, () => void] {
  const [selection, setSelection] = useState<TextSelection | null>(null);
  useEffect(() => {
    const read = () => {
      const current = window.getSelection();
      const text = current?.toString().trim();
      const node = current?.anchorNode;
      const element = node ? (node.nodeType === 1 ? node as Element : node.parentElement) : null;
      const block = element?.closest<HTMLElement>("[data-select-block]");
      if (!text || !block || !container.current?.contains(block)) { setSelection(null); return; }
      const page = Number(block.closest<HTMLElement>("[data-page]")?.dataset.page) || undefined;
      setSelection({ text, block, page });
    };
    document.addEventListener("selectionchange", read);
    return () => document.removeEventListener("selectionchange", read);
  }, [container]);
  return [selection, () => { window.getSelection()?.removeAllRanges(); setSelection(null); }];
}

/** 桌面：选区所在块上方的浮动按钮（弹出动画）；触控设备不渲染，由操作区提供同一动作。 */
export function SelectionAsk({ selection, onAsk, label = "问选中内容" }: { selection: TextSelection | null; onAsk: () => void; label?: string }) {
  const [coarse, setCoarse] = useState(false);
  useEffect(() => { setCoarse(window.matchMedia("(pointer: coarse)").matches); }, []);
  if (!selection || coarse) return null;
  return createPortal(
    <button type="button" onMouseDown={event => event.preventDefault()} onClick={onAsk}
      className="absolute -top-11 left-0 z-10 h-9 rounded-md bg-ink px-3 font-sans text-[13px] font-medium text-on-ink shadow-float motion-safe:animate-pop">
      {label}
    </button>,
    selection.block,
  );
}
