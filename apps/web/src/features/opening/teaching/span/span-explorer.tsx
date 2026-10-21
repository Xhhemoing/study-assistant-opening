"use client";

import { useId, useState } from "react";
import { useSpanPresentation } from "./use-span-presentation";
import { ui } from "../../design/ui";

/** A demonstration family only; no independent item operands or answer is used here. */
export function SpanExplorer({ courseId, sourceId }: { courseId: string; sourceId?: string }) {
  const { content, error, reload } = useSpanPresentation(courseId, sourceId, "simulation");
  const [prediction, setPrediction] = useState(""), [sealed, setSealed] = useState<string | null>(null);
  const [alpha, setAlpha] = useState(1), [beta, setBeta] = useState(0);
  const id = useId().replace(/:/g, "");
  if (error) return <div className="space-y-2 text-xs text-amber-900"><p>{error}</p><button type="button" className={ui.secondary} onClick={reload}>重新读取模拟</button></div>;
  if (!content) return <p role="status" className="text-xs text-zinc-500">正在读取模拟与交付记录…</p>;
  const v = content.problem.vectors[0].map(Number), w = content.problem.vectors[1].map(Number), target = content.problem.target.map(Number);
  const result = v.map((value, index) => alpha * value + beta * w[index]!);
  const x = (value: number) => 160 + value * 18;
  const y = (value: number) => 160 - value * 18;
  const description = `示范 v=(${v.join(",")})，w=(${w.join(",")})。α=${alpha}、β=${beta}时，和为(${result.join(",")})，两个坐标始终相同。目标u=(${target.join(",")})两个坐标不同。`;
  return <section className="space-y-4 rounded-xl bg-zinc-50 p-4" aria-label="先预测再操作的 span 模拟">
    <h3 className="text-sm font-medium">先预测：这两支箭头能到达 ({target.join(",")}) 吗？</h3>
    <p className="text-sm leading-7">v=({v.join(",")})，w=({w.join(",")})。只改变它们的系数，先写一个预测和理由，再动手验证。</p>
    {sealed === null ? <form className="space-y-2" onSubmit={event => { event.preventDefault(); if (prediction.trim()) setSealed(prediction); }}><label className="block text-xs">我的预测<textarea className={`${ui.input} mt-1 min-h-20`} value={prediction} maxLength={2000} onChange={event => setPrediction(event.target.value)} required /></label><button className={ui.secondary} disabled={!prediction.trim()}>保留预测，开始操作</button></form> : <>
      <p className="whitespace-pre-wrap text-xs leading-6">原预测：{sealed}</p>
      <div className="grid items-center gap-5 sm:grid-cols-2"><figure><svg viewBox="0 0 320 320" role="img" aria-label={description} className="mx-auto w-full max-w-xs rounded-lg border border-zinc-200 bg-white"><title>系数改变与向量等式同步</title><desc>{description}</desc><defs><marker id={id} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0 L7 3.5 L0 7Z" fill="context-stroke" /></marker></defs><path d="M16 160 H304 M160 16 V304" stroke="currentColor" className="text-zinc-300" /><path d="M16 304 L304 16" stroke="currentColor" strokeDasharray="4 4" className="text-zinc-400" /><line x1="160" y1="160" x2={x(result[0]!)} y2={y(result[1]!)} markerEnd={`url(#${id})`} stroke="currentColor" strokeWidth="3" className="text-emerald-700" /><circle cx={x(target[0]!)} cy={y(target[1]!)} r="5" className="fill-amber-700" /><text x={x(target[0]!) + 7} y={y(target[1]!)} className="fill-amber-800 text-xs">u=({target.join(",")})</text></svg><figcaption className="mt-2 text-xs leading-6 text-zinc-500">绿色箭头：当前组合；虚线：两个坐标相等的直线；圆点：目标。</figcaption></figure>
      <div className="space-y-4">{([["α", alpha, setAlpha], ["β", beta, setBeta]] as const).map(([label, value, set]) => <label key={label} className="flex items-center gap-3 text-sm">{label}={value}<input type="range" min="-2" max="2" step="0.5" value={value} aria-label={`模拟系数 ${label}`} className="min-w-0 flex-1 accent-emerald-700" onChange={event => set(Number(event.target.value))} /></label>)}<p aria-live="polite" className="rounded-lg bg-white p-3 font-mono text-sm leading-7">{alpha}({v.join(",")})+{beta}({w.join(",")})<br />=({result.join(", ")})</p><p className="text-sm leading-7">为什么改系数仍到不了 ({target.join(",")})？试着用“所有组合的两个坐标……”说明，而非只说试过几个数。</p></div></div>
    </>}
    <p className="text-xs leading-6 text-zinc-500">这是已展示的模拟，不计独立新题证据；后面用另一道未显示解答的题检验。</p>
  </section>;
}
