"use client";
import { useId, useState } from "react";
import type { TeachingVectorDiagram } from "@aistudy/contracts";

export function VectorDiagram({ vectors: { v, w } }: { vectors: TeachingVectorDiagram }) {
  const [a, setA] = useState(1), [b, setB] = useState(1);
  const marker = useId().replace(/:/g, "");
  const u = [a * v[0] + b * w[0], a * v[1] + b * w[1]];
  const extent = Math.max(1, 3 * (Math.abs(v[0]) + Math.abs(w[0])), 3 * (Math.abs(v[1]) + Math.abs(w[1])));
  const scale = 95 / extent, x = (value: number) => 160 + value * scale, y = (value: number) => 120 - value * scale;
  const format = (n: number) => Number(n.toFixed(2));
  return <figure className="space-y-3 rounded-xl border border-line bg-surface-2 p-4">
    <figcaption className="text-sm font-medium">拖动系数，看看 αv + βw 怎样移动</figcaption>
    <svg viewBox="0 0 320 240" role="img" aria-label={`v=(${v.join(",")})，w=(${w.join(",")})；当前组合为(${u.map(format).join(",")})`} className="mx-auto max-h-72 w-full text-text-3">
      <defs><marker id={marker} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="context-stroke" /></marker></defs>
      <path d="M20 120H300 M160 220V20" className="stroke-current" fill="none" />
      <text x="302" y="132" className="fill-current text-xs">x</text><text x="166" y="18" className="fill-current text-xs">y</text>
      <path d={`M160 120L${x(a * v[0])} ${y(a * v[1])}L${x(u[0]!)} ${y(u[1]!)}`} className="stroke-text-3" strokeDasharray="4 4" fill="none" />
      {([{ point: v, label: "v", color: "stroke-text-2" }, { point: w, label: "w", color: "stroke-text-2" }, { point: u, label: "αv+βw", color: "stroke-accent" }]).map(({ point, label, color }) => <g key={label}>
        <line x1="160" y1="120" x2={x(point[0]!)} y2={y(point[1]!)} className={color} strokeWidth={label === "αv+βw" ? 3 : 1.5} markerEnd={`url(#${marker})`} />
        <text x={x(point[0]!) + 5} y={y(point[1]!) - 6} className="fill-text text-xs">{label}</text>
      </g>)}
    </svg>
    <div className="grid gap-3 sm:grid-cols-2">{([{ label: "α", value: a, change: setA }, { label: "β", value: b, change: setB }]).map(control => <label key={control.label} className="text-sm">{control.label} = {control.value}
      <input className="mt-2 block w-full accent-accent" type="range" min={-3} max={3} step={0.5} value={control.value} onChange={event => control.change(Number(event.target.value))} />
    </label>)}</div>
    <p aria-live="polite" className="text-sm">{a}({v.join(", ")}) + {b}({w.join(", ")}) = ({u.map(format).join(", ")})</p>
    <p className="text-xs text-text-2">先把一个系数设为 0，再尝试负数。方向和长度发生了什么变化？</p>
  </figure>;
}
