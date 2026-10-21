"use client";
import Link from "next/link";
import { useMemo } from "react";
import { useCourseBundle } from "./course-detail";
import { StudyNotePanel } from "../opening/teaching/study-context-tools";
import { LibraryDocumentList } from "../workspace/library-document-list";
import { LoadError, LoadingRows, ui } from "../opening/design/ui";

export function CourseNote({ courseId }: { courseId: string }) {
  const { course, loading, error, reload } = useCourseBundle(courseId);
  const context = useMemo(() => ({ courseId, label: course?.title ?? "本课" }), [courseId, course?.title]);
  return <div className="mx-auto w-full max-w-3xl space-y-5 overflow-y-auto p-5 sm:p-7">
    <Link className={ui.quiet} href={`/opening/courses/${encodeURIComponent(courseId)}`}>返回本课</Link>
    {loading ? <LoadingRows label="正在读取课程…" /> : error || !course ? <LoadError message={error || "无法读取本课。"} onRetry={reload} /> : <>
      <h1 className="text-xl font-semibold">{course.title} / 新笔记</h1>
      <p className="text-sm leading-6 text-text-3">保存后归入本课。离开前未保存的内容保留为草稿，不会创建空笔记。</p>
      <StudyNotePanel key={courseId} context={context} />
    </>}
  </div>;
}

export function CourseNotes({ courseId }: { courseId: string }) {
  const { course, assets, loading, error, reload } = useCourseBundle(courseId);
  if (loading) return <LoadingRows label="正在读取本课笔记…" />;
  if (error || !course) return <LoadError message={error || "无法读取本课笔记。"} onRetry={reload} />;
  return <div className="space-y-4"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-medium">{course.title} · 本课笔记</p><Link className={ui.quiet} href={`/opening/courses/${encodeURIComponent(courseId)}`}>返回本课</Link></div><LibraryDocumentList basePath="/opening/library" courseId={courseId} documentIds={assets.filter(asset => asset.document).map(asset => asset.document!.id)} /></div>;
}
