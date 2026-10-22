"use client";
import { useId } from "react";
import { useTween } from "../motion/use-tween";

export type Matrix2 = readonly [number, number, number, number]; // [a, b, c, d] → [[a, b], [c, d]]，列向量为 (a,c)、(b,d)

type Props = {
  matrix: Matrix2;
  onChange: (matrix: Matrix2) => void;
  presets?: { label: string; matrix: Matrix2 }[];
};

const U = 40;           // 每单位像素
const R = 5;            // 网格半径
const P = (x: number, y: number) => `${x * U},${-y * U}`;
const xy = (x: number, y: number) => ({ x: x * U, y: -y * U });

/**
 * 交互画布（study/matrix、study/span 的布局模板）。矩阵变化时网格、基向量、单位正方形逐帧补间，
 * 面积 = |det| 实时显示。几何只写 SVG 属性，不用内联样式；减少动效时直接跳到结果。
 */
export function LinearMapCanvas({ matrix, onChange, presets = [] }: Props) {
  const [a = 1, b = 0, c = 0, d = 1] = useTween(matrix, 420);
  const det = matrix[0] * matrix[3] - matrix[1] * matrix[2];
  const id = useId();
  const map = (x: number, y: number) => P(a * x + b * y, c * x + d * y);
  const pt = (x: number, y: number) => xy(a * x + b * y, c * x + d * y);
  const seg = (p: { x: number; y: number }, q: { x: number; y: number }) => ({ x1: p.x, y1: p.y, x2: q.x, y2: q.y });
  const lines = Array.from({ length: 2 * R + 1 }, (_, i) => i - R);
  const names = ["a", "b", "c", "d"] as const;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
      <figure className="overflow-hidden rounded-card border border-line bg-surface">
        <svg viewBox={`${-R * U} ${-R * U} ${2 * R * U} ${2 * R * U}`} role="img" aria-labelledby={`${id}-cap`} className="mx-auto block h-auto w-full max-w-[520px] text-text-2">
          <g stroke="currentColor" strokeOpacity=".12">{lines.map(n => <g key={n}><line x1={n * U} y1={-R * U} x2={n * U} y2={R * U} /><line x1={-R * U} y1={n * U} x2={R * U} y2={n * U} /></g>)}</g>
          <g stroke="var(--color-obj-1)" strokeOpacity=".35">{lines.map(n => <g key={n}><line {...seg(pt(n, -R), pt(n, R))} /><line {...seg(pt(-R, n), pt(R, n))} /></g>)}</g>
          <polygon points={`${map(0, 0)} ${map(1, 0)} ${map(1, 1)} ${map(0, 1)}`} fill="var(--color-obj-3)" fillOpacity=".18" stroke="var(--color-obj-3)" strokeDasharray="4 3" />
          <line x1="0" y1="0" x2={a * U} y2={-c * U} stroke="var(--color-obj-1)" strokeWidth="3" strokeLinecap="round" />
          <line x1="0" y1="0" x2={b * U} y2={-d * U} stroke="var(--color-obj-2)" strokeWidth="3" strokeLinecap="round" />
          <circle r="3" fill="currentColor" />
        </svg>
        <figcaption id={`${id}-cap`} className="flex items-center justify-between border-t border-line px-4 py-2 text-[13px] text-text-2">
          <span>单位正方形变为平行四边形</span>
          <span className="tabular-nums text-text">面积 = |det| = <span key={det} className="inline-block motion-safe:animate-pop">{Math.abs(det).toFixed(2).replace(/\.00$/, "")}</span></span>
        </figcaption>
      </figure>
      <div className="space-y-4">
        <fieldset className="grid grid-cols-2 gap-3">
          <legend className="mb-2 text-[13px] font-medium text-text-2">矩阵</legend>
          {names.map((name, index) => (
            <label key={name} className="space-y-1 text-[13px] text-text-2">
              <span className="flex justify-between"><span>{name}</span><span className="tabular-nums text-text">{matrix[index] ?? 0}</span></span>
              <input type="range" min={-3} max={3} step={0.5} value={matrix[index] ?? 0} aria-label={`矩阵元素 ${name}`}
                onChange={event => { const next = [...matrix] as [number, number, number, number]; next[index] = Number(event.target.value); onChange(next); }}
                className="block w-full accent-accent" />
            </label>
          ))}
        </fieldset>
        {presets.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {presets.map(preset => (
              <button key={preset.label} type="button" onClick={() => onChange(preset.matrix)}
                className="min-h-9 rounded-pill border border-line px-3 text-[13px] text-text-2 transition-[background-color,transform] duration-(--duration-micro) hover:bg-surface-2 active:scale-95">{preset.label}</button>
            ))}
          </div>
        )}
        <p className="text-[13px] leading-6 text-text-2">{det === 0 ? "行列式为 0：两列共线，平面被压成一条线。" : det < 0 ? "行列式为负：方向翻转，面积取绝对值。" : "两列不共线，可以张成整个平面。"}</p>
      </div>
    </div>
  );
}
