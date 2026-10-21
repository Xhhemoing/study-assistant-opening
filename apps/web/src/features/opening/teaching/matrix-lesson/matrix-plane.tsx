"use client";

import { useEffect, useId, useState } from "react";
import { Pause, Play, RotateCcw, StepBack, StepForward } from "lucide-react";
import { readPrefersReducedMotion } from "../blocks/matrix-transform";
import { ui } from "../../design/ui";
import { useAppearancePreferences } from "../../settings/appearance-preferences";
import { OBSERVATION_MATRIX, PLANE_PRESETS, matrixText, planeDecomposition, transformPlaneVector, vectorText, type PlaneMatrix, type PlaneVector } from "./lesson-model";

const phaseLabels = ["先看原向量 v", "第一列负责 x 倍的横向一步", "第二列负责 y 倍的纵向一步", "把两段相加，得到 Av"];

export function MatrixPlaneDiagram({ matrix, vector, phase = 3, originalOnly = false }: { matrix: PlaneMatrix; vector: PlaneVector; phase?: number; originalOnly?: boolean }) {
  const markerId = useId().replace(/:/g, "");
  const { first, second, result } = planeDecomposition(matrix, vector);
  const grid = [-2, -1, 0, 1, 2];
  const gridLines: Array<readonly [PlaneVector, PlaneVector]> = grid.flatMap(value => [[[-2, value], [2, value]], [[value, -2], [value, 2]]] as Array<readonly [PlaneVector, PlaneVector]>);
  const transformed = gridLines.map(([from, to]) => [transformPlaneVector(matrix, from), transformPlaneVector(matrix, to)] as const);
  const visible = originalOnly ? [...vector] : [...vector, ...first, ...second, ...result, ...transformed.flat(2)];
  const extent = Math.max(3, ...visible.map(Math.abs)) + 1;
  const x = (value: number) => 180 + value * 150 / extent;
  const y = (value: number) => 180 - value * 150 / extent;
  const point = (value: PlaneVector) => `${x(value[0])},${y(value[1])}`;
  function arrow(from: PlaneVector, to: PlaneVector, label: string, color: string, dashed = false) {
    return <g key={label} className={color}><title>{label}：{vectorText([to[0] - from[0], to[1] - from[1]])}</title><line x1={x(from[0])} y1={y(from[1])} x2={x(to[0])} y2={y(to[1])} stroke="currentColor" strokeWidth="3" strokeDasharray={dashed ? "5 4" : undefined} markerEnd={`url(#${markerId})`} /><text x={x(to[0]) + 7} y={y(to[1]) - 8} fill="currentColor" className="text-[12px] font-semibold">{label}</text></g>;
  }
  const description = originalOnly ? `原向量 v=${vectorText(vector)}。变换结果保留到你提交思考之后。` : `A=${matrixText(matrix)}，v=${vectorText(vector)}；第一列贡献 ${vectorText(first)}，第二列贡献 ${vectorText(second)}，相加得到 Av=${vectorText(result)}。`;
  return <figure className="space-y-2">
    <svg viewBox="0 0 360 360" role="img" aria-label={description} className="mx-auto w-full max-w-sm rounded-xl border border-line bg-surface">
      <title>矩阵对平面向量的作用</title><desc>{description}</desc>
      <defs><marker id={markerId} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto-start-reverse"><path d="M 0 0 L 7 3.5 L 0 7 z" fill="context-stroke" /></marker></defs>
      {gridLines.map(([from, to], index) => <line key={`grid-${index}`} x1={x(from[0])} y1={y(from[1])} x2={x(to[0])} y2={y(to[1])} stroke="currentColor" className="text-line" />)}
      {!originalOnly && phase > 0 ? transformed.map(([from, to], index) => <line key={`transformed-${index}`} x1={x(from[0])} y1={y(from[1])} x2={x(to[0])} y2={y(to[1])} stroke="currentColor" className="text-emerald-200" />) : null}
      <path d="M 20 180 H 340 M 180 20 V 340" fill="none" stroke="currentColor" className="text-text-3" />
      <text x="342" y="175" className="fill-text-3 text-xs">x</text><text x="188" y="20" className="fill-text-3 text-xs">y</text><text x="186" y="194" className="fill-text-3 text-xs">0</text>
      {grid.filter(value => value !== 0).map(value => <g key={value}><text x={x(value)} y="194" textAnchor="middle" className="fill-text-3 text-xs">{value}</text><text x="170" y={y(value) + 3} textAnchor="end" className="fill-text-3 text-xs">{value}</text></g>)}
      {arrow([0, 0], vector, "v", "text-obj-1", !originalOnly && phase > 0)}
      {!originalOnly && phase >= 1 ? arrow([0, 0], first, "x·第1列", "text-obj-3") : null}
      {!originalOnly && phase >= 2 ? arrow(first, result, "y·第2列", "text-obj-2") : null}
      {!originalOnly && phase === 3 ? arrow([0, 0], result, "Av", "text-violet-700 [[data-theme=dark]_&]:text-violet-300") : null}
      <circle cx={x(0)} cy={y(0)} r="3" className="fill-text-2" />
      {!originalOnly && phase >= 2 ? <polyline points={`${point([0, 0])} ${point(second)} ${point(result)}`} fill="none" stroke="currentColor" strokeDasharray="3 4" className="text-amber-400" /> : null}
    </svg>
    <figcaption className="text-xs leading-6 text-text-2">{originalOnly ? description : <><span className="font-medium text-obj-1">蓝色：原向量</span>；<span className="font-medium text-obj-3">绿色：第一列贡献</span>；<span className="font-medium text-obj-2">橙色：第二列贡献</span>；<span className="font-medium text-violet-700 [[data-theme=dark]_&]:text-violet-300">紫色：两段的和</span>。淡绿网格表示原网格经过 A 后的位置。</>}</figcaption>
  </figure>;
}

export function MatrixPlaneExplorer({ interactiveEnabled }: { interactiveEnabled: boolean }) {
  const [matrix, setMatrix] = useState<PlaneMatrix>(OBSERVATION_MATRIX);
  const [vector, setVector] = useState<PlaneVector>([1, 1]);
  const [phase, setPhase] = useState(0);
  const [playing, setPlaying] = useState(false);
  const { preferences } = useAppearancePreferences();
  const [systemReducedMotion, setReducedMotion] = useState(false);
  const reducedMotion = preferences.motion === "reduce" || systemReducedMotion;
  useEffect(() => { if (reducedMotion) setPlaying(false); }, [reducedMotion]);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => { setReducedMotion(readPrefersReducedMotion(media)); if (media.matches) setPlaying(false); };
    sync(); media.addEventListener?.("change", sync);
    return () => media.removeEventListener?.("change", sync);
  }, []);
  useEffect(() => {
    if (!interactiveEnabled || !playing || reducedMotion) return;
    if (phase === 3) { setPlaying(false); return; }
    const timer = window.setTimeout(() => setPhase(value => Math.min(3, value + 1)), 1400);
    return () => window.clearTimeout(timer);
  }, [interactiveEnabled, playing, reducedMotion, phase]);
  const { first, second, result } = planeDecomposition(matrix, vector);
  const shownPhase = interactiveEnabled ? phase : 3;
  const selectedPreset = PLANE_PRESETS.findIndex(preset => JSON.stringify(preset.matrix) === JSON.stringify(matrix));
  const step = (delta: number) => { setPlaying(false); setPhase(value => Math.max(0, Math.min(3, value + delta))); };
  return <div className="space-y-4">
    {!interactiveEnabled ? <p role="status" className="text-xs text-text-2">当前工作区关闭了交互图示，保留同一参数的静态图和完整文字。</p> : <fieldset className="grid gap-3 rounded-xl bg-surface-2 p-3 sm:grid-cols-2"><legend className="px-1 text-xs font-medium text-text-2">动手改一改（滑块可用方向键调节）</legend>
      <label className="text-xs sm:col-span-2">变换<select className="ml-2 max-w-full rounded border border-line bg-surface px-2 py-2" value={selectedPreset < 0 ? "custom" : String(selectedPreset)} onChange={event => { const preset = PLANE_PRESETS[Number(event.target.value)]; if (preset) { setMatrix(preset.matrix); setPhase(0); setPlaying(false); } }}><option value="custom" disabled>自定义参数</option>{PLANE_PRESETS.map((preset, index) => <option key={preset.label} value={index}>{preset.label}</option>)}</select></label>
      {matrix.flatMap((row, rowIndex) => row.map((value, columnIndex) => <label key={`${rowIndex}:${columnIndex}`} className="flex items-center gap-2 text-xs">A{rowIndex + 1}{columnIndex + 1} = {value}<input aria-label={`矩阵第${rowIndex + 1}行第${columnIndex + 1}列`} className="min-w-0 flex-1 accent-emerald-700" type="range" min="-2" max="2" step="1" value={value} onChange={event => { const next = matrix.map(row => [...row]); next[rowIndex]![columnIndex] = Number(event.target.value); setMatrix(next as unknown as PlaneMatrix); setPlaying(false); }} /></label>))}
      {vector.map((value, index) => <label key={index} className="flex items-center gap-2 text-xs">{index ? "y" : "x"} = {value}<input aria-label={index ? "原向量纵坐标" : "原向量横坐标"} className="min-w-0 flex-1 accent-blue-700" type="range" min="-2" max="2" step="1" value={value} onChange={event => { setVector(index ? [vector[0], Number(event.target.value)] : [Number(event.target.value), vector[1]]); setPlaying(false); }} /></label>)}
    </fieldset>}
    <div className="grid items-start gap-5 lg:grid-cols-2" tabIndex={interactiveEnabled ? 0 : undefined} role="group" aria-label="矩阵几何演示；方向键逐步，空格播放暂停，Home回到开头" onKeyDown={event => { if (!interactiveEnabled || event.target !== event.currentTarget) return; if (event.key === "ArrowRight" || event.key === "ArrowLeft") { event.preventDefault(); step(event.key === "ArrowRight" ? 1 : -1); } else if (event.key === "Home") { event.preventDefault(); setPlaying(false); setPhase(0); } else if (event.key === " " && !reducedMotion) { event.preventDefault(); if (phase === 3) setPhase(0); setPlaying(value => !value); } }}>
      <MatrixPlaneDiagram matrix={matrix} vector={vector} phase={shownPhase} />
      <div className="space-y-3 text-sm leading-7"><p className="font-mono">A = {matrixText(matrix)}<br />v = {vectorText(vector)}</p><p role="status" aria-live="polite" className="font-medium text-obj-3">{shownPhase + 1}/4 · {phaseLabels[shownPhase]}</p><p>把 v 拆成 x 个横向单位向量和 y 个纵向单位向量。A 的两列，分别告诉你这两种单位步子被送到哪里。</p><p className="rounded-lg bg-accent-soft text-text p-3 font-mono text-xs leading-7">x·第1列 = {vectorText(first)}<br />y·第2列 = {vectorText(second)}<br />Av = {vectorText(first)} + {vectorText(second)} = {vectorText(result)}</p>{result[0] === 0 && result[1] === 0 ? <p className="text-xs text-violet-800 [[data-theme=dark]_&]:text-violet-300">这次 Av 是零向量，终点回到原点；零向量没有方向。</p> : null}<p className="text-xs text-text-3">图、式和文字使用同一组参数。图中变化帮助你观察关系，数学结论由矩阵运算给出。</p></div>
    </div>
    {interactiveEnabled ? <div className="flex flex-wrap gap-2"><button type="button" className={ui.secondary} disabled={reducedMotion} aria-pressed={playing} onClick={() => { if (phase === 3) setPhase(0); setPlaying(value => !value); }}>{playing ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}{playing ? "暂停" : "播放四步"}</button><button type="button" className={ui.secondary} disabled={phase === 0} onClick={() => step(-1)}><StepBack size={14} aria-hidden="true" />前一步</button><button type="button" className={ui.secondary} disabled={phase === 3} onClick={() => step(1)}><StepForward size={14} aria-hidden="true" />后一步</button><button type="button" className={ui.quiet} onClick={() => { setPhase(0); setPlaying(false); }}><RotateCcw size={14} aria-hidden="true" />回看开头</button>{reducedMotion ? <p className="w-full text-xs text-text-3">已按减少动态偏好关闭播放，可用前后步查看。</p> : null}</div> : null}
  </div>;
}
