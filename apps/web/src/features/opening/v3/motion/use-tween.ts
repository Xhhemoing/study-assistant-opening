"use client";
import { useEffect, useRef, useState } from "react";
import { interactionMotionReduced } from "../../design/haptics";

/** 与 --ease-out-expo 一致的缓动，用于必须逐帧计算的 SVG 几何（如线性变换画布）。 */
const easeOutExpo = (t: number) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t));

/** 把一组数值从当前值补间到目标值；减少动效时直接跳到目标。只在 rAF 中更新，不写 style。 */
export function useTween(target: readonly number[], durationMs = 320): number[] {
  const [value, setValue] = useState<number[]>(() => [...target]);
  const from = useRef<number[]>([...target]);
  const current = useRef<number[]>([...target]);
  const key = target.join(",");
  useEffect(() => {
    if (interactionMotionReduced()) { current.current = [...target]; setValue([...target]); return; }
    from.current = [...current.current];
    const begin = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const t = easeOutExpo(Math.min(1, (now - begin) / durationMs));
      current.current = target.map((goal, i) => { const start = from.current[i] ?? goal; return start + (goal - start) * t; });
      setValue(current.current);
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [key, durationMs]);
  return value;
}
