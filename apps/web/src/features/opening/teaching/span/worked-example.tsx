"use client";
import { useState } from "react";
import { ui } from "../../design/ui";
import { useSpanPresentation } from "./use-span-presentation";
export function SpanWorkedExample({ courseId, sourceId, fast, sessionId }: { courseId: string; sourceId?: string; fast: boolean; sessionId?: string }) {
  const { content, error, reload } = useSpanPresentation(courseId, sourceId, "worked", sessionId);
  const [reveal, setReveal] = useState(0);
  const shown = fast ? 2 : reveal;
  if (error) return <div role="status" className="space-y-2 text-xs text-warn"><p>{error}</p><button type="button" className={ui.secondary} onClick={reload}>重新读取示范</button></div>;
  if (!content) return <p role="status" className="text-xs text-text-2">正在读取并记录本题的示范交付…</p>;
  const problem = content.problem;
  return <div className="space-y-4 rounded-xl border border-line bg-accent-soft text-text p-4"><p className="font-mono text-sm">v=({problem.vectors[0].join(", ")})，w=({problem.vectors[1].join(", ")})，u=({problem.target.join(", ")})</p><p className="text-sm leading-7">span 是所有 αv+βw 的集合。判断 u 能否到达，就是找一组让所有坐标同时成立的系数。</p>{shown >= 1 ? <div className="font-mono text-sm leading-8"><p>α({problem.vectors[0].join(",")})+β({problem.vectors[1].join(",")})=({problem.target.join(",")})</p>{problem.target.map((coordinate, index) => <p key={index}>第{index + 1}坐标：{problem.vectors[0][index]}α + {problem.vectors[1][index]}β = {coordinate}</p>)}</div> : null}{shown >= 2 && content.solution.kind === "unique" ? <p className="text-sm leading-8">所以 α={content.solution.coefficients[0]}，β={content.solution.coefficients[1]}。分别代回上面的每一个坐标方程；所有等式同时成立，因此属于 span。</p> : null}{shown < 2 ? <button type="button" className={ui.secondary} onClick={() => setReveal(value => value + 1)}>{reveal ? "揭示系数与全部坐标核对" : "揭示如何建立方程"}</button> : null}<p className="text-xs leading-6 text-text-2">这道示范的实际交付已记录，不计独立作答；同题与同题族不会被当作新的未曝光保留检查。</p></div>;
}
export function SpanOverviewLinks({ courseId, sourceId, sessionId }: { courseId: string; sourceId?: string; sessionId?: string }) {
  const { content, error, reload } = useSpanPresentation(courseId, sourceId, "overview", sessionId);
  if (error) return <div className="space-y-2 text-xs text-warn"><p>{error}</p><button type="button" className={ui.secondary} onClick={reload}>重新读取方程与几何示范</button></div>;
  if (!content) return <p role="status" className="text-xs text-text-2">正在读取跨知识点的示范…</p>;
  return <div className="space-y-3 rounded-xl bg-surface-2 p-4 text-sm leading-8"><h3 className="font-medium">连接三个知识点</h3><p>向量等式的每一坐标对应一条线性方程；能同时满足就是相容。两个独立的三维生成向量张成过原点的平面，相关的生成向量只张成直线。</p><p>本例 v=({content.problem.vectors[0].join(",")})，w=({content.problem.vectors[1].join(",")})。任意组合都满足 z=x+y。这是平面的约束，也是第三个坐标必须核对的理由。</p><p className="text-xs text-text-2">本题已作为示范交付；后续分别检查等式、系统结构与几何判断。文字解释质量仍另行核对。</p></div>;
}
