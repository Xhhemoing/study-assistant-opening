"use client";

import type { StudyGoal } from "@aistudy/contracts";
import { ArrowLeft, BookOpen, Target } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { GuidanceMode } from "../../lib/data/types";
import { useStudyProvider } from "../../lib/data/react";
import { EmptyState, LoadError, LoadingRows, PageHeading, ui } from "../opening/design/ui";
import { CourseLearningView } from "../opening/learning/course-view";
import { formatExamDate, goalPath, scenarioLabel } from "../goals/goal-model";
import type { CourseAsset, CourseSummary } from "./course-model";
import { CourseSettingsPanel } from "./course-settings-panel";
import { createCourseStateClient } from "./course-state-client";
import { CourseStudyActions } from "./course-study-actions";

const guidanceModes: Array<{ value: GuidanceMode; label: string }> = [{ value: "direct", label: "直接讲解" }, { value: "balanced", label: "平衡" }, { value: "socratic", label: "苏格拉底式追问" }];

function CourseAssets({ courseId, assets, onRemoved, libraryHref }: { courseId: string; assets: CourseAsset[]; onRemoved: (id: string) => void; libraryHref: string }) {
  const [selected, setSelected] = useState<CourseAsset | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function remove() {
    if (!selected) return;
    setBusy(true); setError("");
    try {
      await createCourseStateClient().removeAsset(courseId, selected);
      onRemoved(selected.id); setSelected(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "移出课程失败，请重试。"); }
    finally { setBusy(false); }
  }
  return <div className="space-y-3"><ul className="divide-y divide-zinc-200 border-y border-zinc-200">{assets.map((asset) => <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3" key={asset.id}>
    <span className="flex min-w-0 flex-1 items-center gap-3"><BookOpen aria-hidden="true" className="shrink-0 text-emerald-700" size={17} />{asset.document ? <Link href={`${libraryHref}#document-${encodeURIComponent(asset.document.id)}`} className="truncate text-sm text-zinc-800 underline decoration-zinc-300 underline-offset-4 hover:text-emerald-800 focus-visible:ring-2 focus-visible:ring-emerald-700">{asset.document.title}</Link> : <span className="truncate text-sm text-zinc-800">{asset.source?.name ?? `资产 ${asset.assetId}`}</span>}</span>
    <span className="shrink-0 text-xs text-zinc-500">{asset.role}</span><button className={ui.quiet} disabled={busy} onClick={() => { setSelected(asset); setError(""); }} type="button" aria-label={`将 ${asset.document?.title ?? asset.source?.name ?? asset.assetId} 移出此课程`}>移出课程</button>
  </li>)}</ul>
    {selected ? <div className="space-y-2"><p className="text-xs leading-6 text-zinc-600">将“{selected.document?.title ?? selected.source?.name ?? selected.assetId}”移出此课程？原件和其他课程中的引用仍保留，此操作不会删除资产或停止模型使用。</p><div className="flex gap-2"><button className={ui.secondary} disabled={busy} onClick={() => void remove()} type="button">{busy ? "移出中…" : "确认移出此课程"}</button><button className={ui.quiet} disabled={busy} onClick={() => { setSelected(null); setError(""); }} type="button">取消</button></div></div> : null}
    {error ? <LoadError message={error} /> : null}
  </div>;
}
export function CourseDetail({ id, opening = false }: { id: string; opening?: boolean }) {
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

  const back = opening ? "/opening/courses" : "/learn/courses";
  if (loading) return <LoadingRows label="正在读取课程…" />;
  if (error || !course) return <main className="p-5"><Link className={ui.quiet} href={back}><ArrowLeft size={14} aria-hidden="true" />返回课程</Link><LoadError message={error || "找不到这门课程。"} onRetry={() => setReloadToken((value) => value + 1)} /></main>;
  return <main className="flex h-full min-h-0 flex-col bg-white text-zinc-800">
    <PageHeading title={course.title} description={course.description || "课程材料、学习目标与实际观察记录。"} action={<Link className={ui.quiet} href={back}><ArrowLeft size={14} aria-hidden="true" />全部课程</Link>} />
    <div className="min-h-0 flex-1 overflow-y-auto"><div className="mx-auto w-full max-w-5xl space-y-6 px-5 py-5">
      <CourseStudyActions assetCount={assets.length} goalCount={goals.length} opening={opening} />
      <CourseLearningView courseId={id} />
      <section id="course-assets" className="scroll-mt-6 border-t border-zinc-200 pt-5" aria-labelledby="course-assets-heading"><div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-semibold" id="course-assets-heading">课程材料</h2><Link className={ui.quiet} href={opening ? "/opening/library?tab=materials" : "/library?tab=materials"}>管理知识库</Link></div>{assets.length ? <CourseAssets key={id} courseId={id} assets={assets} libraryHref={opening ? "/opening/library?tab=notes" : "/library"} onRemoved={(assetId) => setAssets((current) => current.filter((asset) => asset.id !== assetId))} /> : <EmptyState title="还没有挂接课程材料" description="笔记和材料可以先独立保存在知识库中。" />}</section>
      <section className="border-t border-zinc-200 pt-4" aria-labelledby="course-goals-heading"><div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-semibold" id="course-goals-heading">学习目标</h2><Link className={ui.secondary} href={`/learn/goals/new?courseId=${encodeURIComponent(id)}`}><Target aria-hidden="true" size={14} />添加目标</Link></div>{goals.length === 0 ? <p className="text-sm leading-7 text-zinc-500">还没有目标。可以先自由学习，或添加一个明确方向。</p> : <ul className="divide-y divide-zinc-200 border-y border-zinc-200">{goals.map((goal) => <li key={goal.id} className="flex flex-wrap items-center justify-between gap-3 py-3"><Link className="flex min-w-0 items-center gap-2 text-sm font-medium hover:text-emerald-800 focus-visible:outline focus-visible:outline-emerald-700" href={goalPath(goal.id)}><Target aria-hidden="true" size={14} /><span className="truncate">{goal.title}</span></Link><span className="text-xs text-zinc-500">{scenarioLabel(goal.scenario)} · {formatExamDate(goal.examDate)}</span></li>)}</ul>}</section>
      <details className="border-y border-zinc-200 py-3"><summary className="cursor-pointer text-xs font-medium">指导模式 · {guidanceModes.find((mode) => mode.value === guidanceMode)?.label}</summary><div className="mt-3 max-w-sm space-y-2"><p className="text-xs leading-6 text-zinc-500">课程暂沿用工作区的指导模式。</p><select aria-label="指导模式" className={ui.input} onChange={(event) => void changeGuidanceMode(event.target.value as GuidanceMode)} value={guidanceMode}>{guidanceModes.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}</select></div></details>
      <CourseSettingsPanel key={id} course={course} onChange={(saved) => setCourse((current) => current?.id === saved.id ? saved : current)} />
      <Link className={ui.quiet} href={opening ? "/opening/today" : "/learn"}><BookOpen aria-hidden="true" size={14} />返回今日学习</Link>
    </div></div>
  </main>;
}
