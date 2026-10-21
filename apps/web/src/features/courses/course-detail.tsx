"use client";

import { ArrowLeft, BookOpen } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { EmptyState, LoadError, LoadingRows, PageHeading, ui } from "../opening/design/ui";
import { CourseLearningView, CourseSummaryPanel } from "../opening/learning/course-view";
import type { CourseAsset, CourseSummary } from "./course-model";
import { CourseAddMaterials } from "./course-add-materials";
import { CourseSettingsPanel } from "./course-settings-panel";
import { createCourseStateClient } from "./course-state-client";
import { CourseStudyActions } from "./course-study-actions";
import { CourseGoalForm } from "./course-goal-form";
import { CourseKnowledge } from "../opening/knowledge/course-knowledge";
import { CourseExamProgress } from "../opening/exam-sprint/course-exam-progress";
import { MediaReader } from "../opening/sources/media-reader";
import { createOpeningApi } from "../opening/client/api";
import { sourceViewerHref } from "../opening/inbox/source-viewer";
import { CoursePanel, CourseTabs } from "./course-tabs";
import { legacyCourseStudyHref } from "./course-tabs-route";
import { CourseSprintMode } from "./course-sprint-mode";
import { useOpeningCapabilities } from "../opening/capabilities/capabilities-provider";
import { LearnerStateCard } from "../opening/teaching/learner-state-card";

function revealCourseMaterials() {
  let node: HTMLElement | null = document.getElementById("course-assets");
  while (node) { if (node instanceof HTMLDetailsElement) node.open = true; node = node.parentElement; }
}

export function CourseContents({ courseId, assets }: { courseId: string; assets: CourseAsset[] }) {
  const [versions, setVersions] = useState<Record<string, number>>({});
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setVersions({}); setError("");
    if (assets.some(asset => asset.source)) void createOpeningApi().listSources().then(rows => {
      if (active) setVersions(Object.fromEntries(rows.map(source => [source.id, source.version])));
    }).catch(() => { if (active) setError("材料版本暂时无法读取，请重试或从材料库打开。"); });
    return () => { active = false; };
  }, [assets, revision]);
  return <section aria-labelledby="course-contents-heading" className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-semibold" id="course-contents-heading">本课内容</h2><a className={ui.quiet} href="#course-assets" onClick={revealCourseMaterials}>管理材料</a></div>
    {assets.length ? <ul className="space-y-2">{assets.slice(0, 5).map(asset => <li className="min-w-0 text-sm" key={asset.id}>{asset.source && versions[asset.source.id] !== undefined ? <a className="break-words text-emerald-800 underline underline-offset-4 focus-visible:ring-2 focus-visible:ring-emerald-700" href={sourceViewerHref(asset.source.id, versions[asset.source.id]!)}>{asset.source.name}</a> : asset.document ? <Link className="break-words text-emerald-800 underline underline-offset-4" href={`/opening/library/${encodeURIComponent(asset.document.id)}`}>{asset.document.title}</Link> : <span className="break-words text-zinc-600">{asset.source?.name ?? "课程材料"}</span>}</li>)}</ul> : <a className={ui.secondary} href="#course-assets" onClick={revealCourseMaterials}>添加本课材料</a>}
    {assets.length > 5 ? <a className={ui.quiet} href="#course-assets" onClick={revealCourseMaterials}>查看全部 {assets.length} 份材料</a> : null}
    {error ? <p className="text-xs leading-6 text-amber-800" role="status">{error}<button className={ui.quiet} type="button" onClick={() => setRevision(value => value + 1)}>重试</button></p> : null}
    <Link className={ui.quiet} href={`/opening/library?tab=materials&courseId=${encodeURIComponent(courseId)}`}>打开课程材料库</Link>
  </section>;
}

export function CourseAssets({ courseId, assets, onRemoved, libraryHref }: { courseId: string; assets: CourseAsset[]; onRemoved: (id: string) => void; libraryHref: string }) {
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

/** Parse course media deep-link query (CT-04 seek when segments exist). */
export function readCourseMediaDeepLink(search: string): { sourceId: string | null; seekMs: number | null } {
  try {
    const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
    const sourceId = params.get("mediaSource")?.trim() || null;
    const raw = params.get("seekMs");
    const seekMs = raw != null && raw !== "" && Number.isFinite(Number(raw)) ? Number(raw) : null;
    return { sourceId, seekMs };
  } catch {
    return { sourceId: null, seekMs: null };
  }
}

/** CT-01 / CT-08: list sources; mount at most one MediaReader after select. */
export function CourseMediaSection({ assets, libraryMaterialsHref = "/opening/library?tab=materials" }: { assets: CourseAsset[]; libraryMaterialsHref?: string }) {
  const sources = useMemo(
    () => assets.flatMap((asset) => (asset.source ? [{ id: asset.source.id, name: asset.source.name }] : [])),
    [assets],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [seekMs, setSeekMs] = useState<number | null>(null);
  const [seekNotice, setSeekNotice] = useState("");

  useEffect(() => {
    if (typeof window === "undefined") return;
    const { sourceId, seekMs: deepSeek } = readCourseMediaDeepLink(window.location.search);
    if (sourceId && sources.some((s) => s.id === sourceId)) {
      setSelectedId(sourceId);
      setSeekMs(deepSeek);
      setSeekNotice(deepSeek != null ? `将尝试定位到 ${Math.floor(deepSeek / 1000)}s（需该材料已有片段）。` : "已选中材料；暂无片段时间，需手动浏览时间轴。");
    } else if (sourceId) {
      setSeekNotice("链接中的材料不在本课媒体列表；请从下方点选，或仅打开材料库查看。");
    }
  }, [sources]);

  if (!sources.length) return null;
  const selected = sources.find((s) => s.id === selectedId) ?? null;

  return (
    <section id="course-media" className="scroll-mt-6 space-y-3 border-t border-zinc-200 pt-5" aria-labelledby="course-media-heading">
      <div>
        <h2 className="text-sm font-semibold" id="course-media-heading">媒体阅读</h2>
        <p className="mt-1 text-xs leading-6 text-zinc-500">先点选一份材料再打开阅读器；不会默认挂载全部媒体。原件已保存但解析失败、仅音频转写、视觉覆盖不足会分别标明。</p>
      </div>
      <ul className="space-y-1.5" aria-label="课程媒体列表">
        {sources.map((source) => (
          <li key={source.id}>
            <button
              type="button"
              className={`w-full rounded-md border px-3 py-2 text-left text-xs ${selectedId === source.id ? "border-emerald-300 bg-emerald-50/60 text-emerald-950" : "border-zinc-200 bg-white text-zinc-800 hover:border-zinc-300"}`}
              aria-pressed={selectedId === source.id}
              onClick={() => { setSelectedId(source.id); setSeekMs(null); setSeekNotice(""); }}
            >
              {source.name}
            </button>
          </li>
        ))}
      </ul>
      {seekNotice ? <p className="text-xs leading-6 text-amber-800" role="status">{seekNotice}</p> : null}
      {selected ? (
        <MediaReader
          key={selected.id}
          sourceId={selected.id}
          source={null}
          onSeek={(ms) => { setSeekMs(ms); setSeekNotice(`已选择片段起点 ${Math.floor(ms / 1000)}s。`); }}
        />
      ) : (
        <p className="text-xs text-zinc-500" role="status">尚未选择材料。点上方名称打开一份阅读器。</p>
      )}
      {selected && seekMs != null ? (
        <p className="text-[11px] text-zinc-500" role="status">当前意向定位：{Math.floor(seekMs / 1000)}s（由片段时间轴按钮触发）。</p>
      ) : null}
      <p className="text-[11px] leading-5 text-zinc-500">
        若知识依据无法定位到片段，会写明「仅打开材料库，暂不能定位」，而不是假 seek。
        <Link className="ml-1 text-emerald-800 underline" href={libraryMaterialsHref}>打开材料库</Link>
      </p>
    </section>
  );
}

export function useCourseBundle(id: string) {
  const [course, setCourse] = useState<CourseSummary | null>(null);
  const [assets, setAssets] = useState<CourseAsset[]>([]);
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
      .catch(() => { if (active) setError("课程内容加载失败，请重试。"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [id, reloadToken]);

  return { course, assets, setCourse, setAssets, loading, error, reload: () => setReloadToken((value) => value + 1) };
}

export type CourseDetailSurface = "opening" | "learn";

const COURSE_DETAIL_PATHS: Record<CourseDetailSurface, {
  coursesList: string;
  libraryMaterials: string;
  libraryNotes: string;
  today: string;
  upload: (courseId: string) => string;
  openingActions: boolean;
}> = {
  opening: {
    coursesList: "/opening/courses",
    libraryMaterials: "/opening/library?tab=materials",
    libraryNotes: "/opening/library?tab=notes",
    today: "/opening/today",
    upload: (courseId) => `/opening/library?tab=materials&courseId=${encodeURIComponent(courseId)}#upload`,
    openingActions: true,
  },
  learn: {
    coursesList: "/learn/courses",
    libraryMaterials: "/library?tab=materials",
    libraryNotes: "/library?tab=notes",
    today: "/learn",
    upload: (courseId) => `/library?tab=materials&courseId=${encodeURIComponent(courseId)}#upload`,
    openingActions: false,
  },
};

/** Real-API course page for Opening and legacy /learn links. Never uses mock study data. */
export function CourseDetail({ id, surface = "opening", mode }: { id: string; surface?: CourseDetailSurface; mode?: "sprint" }) {
  const router = useRouter();
  const { adaptivePlanning } = useOpeningCapabilities();
  const paths = COURSE_DETAIL_PATHS[surface];
  const { course, assets, setCourse, setAssets, loading, error, reload } = useCourseBundle(id);
  useEffect(() => {
    if (!paths.openingActions || mode === "sprint") return;
    function followLegacyStudyLink() {
      const href = legacyCourseStudyHref(id, window.location.search, window.location.hash);
      if (href) router.replace(href);
    }
    followLegacyStudyLink();
    window.addEventListener("hashchange", followLegacyStudyLink);
    return () => window.removeEventListener("hashchange", followLegacyStudyLink);
  }, [id, mode, paths.openingActions, router]);
  if (loading) return <LoadingRows label="正在读取课程…" />;
  if (error || !course) return <section className="p-5"><Link className={ui.quiet} href={paths.coursesList}><ArrowLeft size={14} aria-hidden="true" />返回课程</Link><LoadError message={error || "找不到这门课程。"} onRetry={reload} /></section>;
  if (paths.openingActions && mode === "sprint") return course.id === id ? <CourseSprintMode key={id} course={course} /> : <LoadingRows label="正在核对冲刺课程…" />;

  const studyActions = <CourseStudyActions assetCount={assets.length} opening={paths.openingActions} courseId={id} courseTitle={course.title} archived={Boolean(course.archivedAt)} />;
  const settings = <CourseSettingsPanel key={id} course={course} onChange={(saved) => setCourse((current) => current?.id === saved.id ? saved : current)} />;
  const materials = <section id="course-assets" aria-labelledby="course-assets-heading" className="scroll-mt-6 space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-base font-semibold" id="course-assets-heading">课程材料 · {assets.length}</h2>
      <div className="flex flex-wrap items-center gap-2"><CourseAddMaterials courseId={id} assets={assets} onAdded={reload} /><Link className={ui.quiet} href={paths.libraryMaterials}>管理知识库</Link></div>
    </div>
    {assets.length ? <CourseAssets key={id} courseId={id} assets={assets} libraryHref={paths.libraryNotes} onRemoved={(assetId) => setAssets((current) => current.filter((asset) => asset.id !== assetId))} /> : <EmptyState title="还没有挂接材料" description="点「添加材料」从知识库挂入，或「上传并归入本课」直接上传。" action={<Link className={ui.quiet} href={paths.upload(id)}>上传并归入本课</Link>} />}
  </section>;

  return <section className="flex h-full min-h-0 flex-col bg-bg text-text">
    <PageHeading title={course.title} description={course.description || "课程材料与实际观察记录。"} action={<Link className={ui.quiet} href={paths.coursesList}><ArrowLeft size={14} aria-hidden="true" />全部课程</Link>} />
    <div className="min-h-0 flex-1 overflow-y-auto"><div className="mx-auto w-full max-w-5xl space-y-6 px-5 py-5">
      {paths.openingActions ? <CourseTabs key={id} courseId={id}>
        <CoursePanel name="overview">
          {studyActions}
          <CourseContents courseId={id} assets={assets} />
          {adaptivePlanning ? <section aria-labelledby="course-goal-heading" className="space-y-3 border-t border-line pt-5"><h2 id="course-goal-heading" className="text-base font-semibold">目标与学习安排</h2><CourseGoalForm courseId={id} /></section> : null}
          {settings}
        </CoursePanel>
        <CoursePanel name="units">
          <section className="space-y-3"><h2 className="text-base font-semibold">课程单元</h2><p className="text-sm leading-6 text-text-2">从课程的知识关联和完整目录选择下一步。</p><CourseKnowledge courseId={id} /></section>
          <section className="space-y-3 border-t border-line pt-5"><h2 className="text-base font-semibold">概念课示例</h2><p className="text-sm leading-6 text-text-2">用一节完整的线性代数课体验图示、思考与独立练习。示例不会替换本课程的任务或学习断点。</p><Link className={ui.secondary} href={`/opening/courses/${encodeURIComponent(id)}/study/matrix`}>矩阵怎样变换平面向量</Link></section>
        </CoursePanel>
        <CoursePanel name="progress">
          <h2 className="text-base font-semibold">学习进展与记录</h2>
          <p className="text-sm leading-6 text-text-2">查看当前有效的学习证据与历史记录。自报、提示后的作答和独立完成会分别标明。</p>
          <LearnerStateCard courseId={id} /><CourseExamProgress courseId={id} /><CourseSummaryPanel courseId={id} />
        </CoursePanel>
        <CoursePanel name="materials">{materials}<CourseMediaSection assets={assets} libraryMaterialsHref={paths.libraryMaterials} /></CoursePanel>
      </CourseTabs> : <>
        {studyActions}<CourseLearningView courseId={id} />
        <details className="border-t border-line pt-4"><summary className="min-h-10 cursor-pointer text-sm text-text-2 focus-visible:ring-2 focus-visible:ring-accent">课程资料与设置</summary><div className="mt-3 space-y-5"><CourseKnowledge courseId={id} />{materials}<CourseMediaSection assets={assets} libraryMaterialsHref={paths.libraryMaterials} />{settings}</div></details>
      </>}
      <Link className={ui.quiet} href={paths.today}><BookOpen aria-hidden="true" size={14} />返回今日学习</Link>
    </div></div>
  </section>;
}
