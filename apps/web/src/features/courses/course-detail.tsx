"use client";

import type { StudyGoal } from "@aistudy/contracts";
import { ArrowLeft, BookOpen, RefreshCw, Target } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { GuidanceMode } from "../../lib/data/types";
import { useStudyProvider } from "../../lib/data/react";
import { formatExamDate, goalPath, scenarioLabel } from "../goals/goal-model";
import type { CourseAsset, CourseSummary } from "./course-model";

const guidanceModes: Array<{ value: GuidanceMode; label: string }> = [{ value: "direct", label: "直接讲解" }, { value: "balanced", label: "平衡" }, { value: "socratic", label: "苏格拉底式追问" }];

function CourseAssets({ assets }: { assets: CourseAsset[] }) {
  if (assets.length === 0) return <p className="border-y border-line py-8 text-sm text-text-dim">还没有挂接课程材料。</p>;
  return <ul className="divide-y divide-line border-y border-line">{assets.map((asset) => <li className="flex items-center justify-between gap-4 px-4 py-4" key={asset.id}><span className="flex min-w-0 items-center gap-3"><BookOpen aria-hidden="true" className="shrink-0 text-primary" size={17} /><span className="truncate text-sm text-text">{asset.document?.title ?? `资产 ${asset.assetId}`}</span></span><span className="shrink-0 text-xs text-text-dim">{asset.role}</span></li>)}</ul>;
}

export function CourseDetail({ id }: { id: string }) {
  const provider = useStudyProvider();
  const [course, setCourse] = useState<CourseSummary | null>(null);
  const [assets, setAssets] = useState<CourseAsset[]>([]);
  const [guidanceMode, setGuidanceMode] = useState<GuidanceMode>("balanced");
  const [goals, setGoals] = useState<StudyGoal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    Promise.all([fetch(`/api/courses/${encodeURIComponent(id)}`, { cache: "no-store" }), fetch(`/api/courses/${encodeURIComponent(id)}/assets`, { cache: "no-store" })])
      .then(async ([courseResponse, assetResponse]) => {
        if (!courseResponse.ok || !assetResponse.ok) throw new Error();
        const courseBody = await courseResponse.json() as { course?: CourseSummary };
        const assetBody = await assetResponse.json() as { assets?: CourseAsset[] };
        if (!courseBody.course) throw new Error();
        if (active) { setCourse(courseBody.course); setAssets(assetBody.assets ?? []); }
      })
      .then(async () => {
        if (!provider) return;
        const mode = await provider.getGuidanceMode();
        if (active) setGuidanceMode(mode);
        const allGoals = await provider.listGoals();
        if (active) setGoals(allGoals.filter((goal) => goal.courseId === id));
      })
      .catch(() => { if (active) setError("课程内容加载失败，请重试。"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [id, provider, reloadToken]);

  async function changeGuidanceMode(value: GuidanceMode) {
    try {
      if (provider) await provider.setGuidanceMode(value);
      setGuidanceMode(value);
    } catch {
      setError("指导模式保存失败，请重试。");
    }
  }

  if (loading) return <main className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8"><p className="border-y border-line py-8 text-sm text-text-dim" role="status">正在读取课程…</p></main>;
  if (error || !course) return <main className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8"><Link className="inline-flex w-fit items-center gap-2 text-sm text-text-dim hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" href="/learn/courses"><ArrowLeft aria-hidden="true" size={16} />返回课程</Link><section className="space-y-3 border-y border-line py-8" role="alert"><p className="text-sm text-danger">{error || "找不到这门课程。"}</p><button className="inline-flex min-h-10 items-center gap-2 rounded-md border border-line px-3 text-sm text-text hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" onClick={() => setReloadToken((value) => value + 1)} type="button"><RefreshCw aria-hidden="true" size={16} />重试</button></section></main>;
  return <main className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8"><header className="space-y-3 border-b border-line pb-6"><Link className="inline-flex items-center gap-2 text-sm text-text-dim hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" href="/learn/courses"><ArrowLeft aria-hidden="true" size={16} />返回课程</Link><div className="space-y-1"><p className="text-xs text-text-dim">学习空间 / 课程</p><h1 className="text-2xl font-semibold text-text">{course.title}</h1><p className="text-sm leading-6 text-text-dim">{course.description || "这门课程还没有描述。"}</p></div></header><section className="space-y-3" aria-labelledby="course-assets-heading"><div className="flex items-center justify-between gap-4"><h2 className="text-base font-semibold text-text" id="course-assets-heading">课程材料</h2><Link className="text-xs text-text-dim hover:text-text" href="/library">从知识库管理</Link></div><CourseAssets assets={assets} /></section><section className="space-y-3 border-t border-line pt-6" aria-labelledby="course-goals-heading"><div className="flex items-center justify-between gap-4"><div><h2 className="text-base font-semibold text-text" id="course-goals-heading">学习目标</h2><p className="mt-1 text-sm text-text-dim">目标决定这门课程的学习计划与优先级，可稍后再设。</p></div><Link className="inline-flex min-h-9 items-center gap-2 rounded-md border border-line px-3 text-sm text-text hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" href={`/learn/goals/new?courseId=${encodeURIComponent(id)}`}><Target aria-hidden="true" size={16} />添加目标</Link></div>{goals.length === 0 ? <p className="text-sm text-text-dim">还没有目标。可以先自由学习，或添加一个明确方向让计划围绕它展开。</p> : <ul className="divide-y divide-line border-y border-line">{goals.map((goal) => <li className="flex items-center justify-between gap-4 px-4 py-3" key={goal.id}><Link className="flex min-w-0 items-center gap-3 text-sm font-semibold text-text hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" href={goalPath(goal.id)}><Target aria-hidden="true" className="shrink-0 text-primary" size={16} /><span className="truncate">{goal.title}</span></Link><span className="shrink-0 text-xs text-text-dim">{scenarioLabel(goal.scenario)} · {formatExamDate(goal.examDate)}</span></li>)}</ul>}</section><section className="space-y-3 border-t border-line pt-6" aria-labelledby="course-guidance-heading"><div><h2 className="text-base font-semibold text-text" id="course-guidance-heading">指导模式</h2><p className="mt-1 text-sm text-text-dim">课程暂沿用工作区的指导模式。</p></div><select className="min-h-10 w-full rounded-md border border-line bg-surface px-3 text-sm text-text outline-none focus:border-primary focus:ring-2 focus:ring-primary/30" onChange={(event) => void changeGuidanceMode(event.target.value as GuidanceMode)} value={guidanceMode}>{guidanceModes.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}</select></section><Link className="inline-flex w-fit min-h-10 items-center gap-2 rounded-md bg-primary px-3 text-sm font-semibold text-ink hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" href="/learn"><BookOpen aria-hidden="true" size={16} />返回今日学习</Link></main>;
}
