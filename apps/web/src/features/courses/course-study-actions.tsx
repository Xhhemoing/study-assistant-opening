import Link from "next/link";
import { ArrowRight, BookOpen, ClipboardList } from "lucide-react";
import { ui } from "../opening/design/ui";

export function CourseStudyActions({ assetCount, goalCount, opening = false }: { assetCount: number; goalCount?: number; opening?: boolean }) {
  const countText = typeof goalCount === "number" ? `${assetCount} 份课程材料 · ${goalCount} 个学习目标` : `${assetCount} 份课程材料`;
  return <section className="border-b border-zinc-200 pb-5" aria-labelledby="course-study-heading">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h2 id="course-study-heading" className="text-sm font-semibold text-zinc-800">开始这次学习</h2>
      <p className="text-xs text-zinc-500">{countText}</p>
    </div>
    <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-600">先回忆一个知识点或独立解题，再核对并记录结果。需要帮助时，可以在本次练习中打开提示或解析。</p>
    <nav aria-label="课程学习方式" className="mt-3 flex flex-wrap gap-2">
      <a className={ui.primary} href="#course-practice">开始独立练习<ArrowRight size={14} aria-hidden="true" /></a>
      <a className={ui.secondary} href="#course-assets"><BookOpen size={14} aria-hidden="true" />查看课程材料</a>
      <a className={ui.quiet} href="#course-learning-records"><ClipboardList size={14} aria-hidden="true" />查看学习记录</a>
      <Link className={ui.quiet} href={opening ? "/opening/library?tab=notes" : "/library/new"}>写一篇笔记</Link>
    </nav>
    <p className="mt-2 text-xs leading-5 text-zinc-500">没有材料或目标也能开始；独立练习和自报记录不需要 AI。</p>
  </section>;
}
