import Link from "next/link";
import { ArrowRight, ClipboardList } from "lucide-react";
import { ui } from "../opening/design/ui";

/** Primary learning CTA only; materials / records stay secondary (CT-01 / CT-02). */
export function CourseStudyActions({ assetCount, goalCount, opening = false }: { assetCount: number; goalCount?: number; opening?: boolean }) {
  const countText = typeof goalCount === "number" ? `${assetCount} 份课程材料 · ${goalCount} 个学习目标` : `${assetCount} 份课程材料`;
  return <section className="border-b border-zinc-200 pb-5" aria-labelledby="course-study-heading">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h2 id="course-study-heading" className="text-sm font-semibold text-zinc-800">开始这次学习</h2>
      <p className="text-xs text-zinc-500">{countText}</p>
    </div>
    <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-600">一次主路径：选主题 → 作答 → 保存。材料与设置在下方折叠区，不与主行动抢注意力。</p>
    <nav aria-label="课程学习方式" className="mt-3 flex flex-wrap items-center gap-2">
      <a className={ui.primary} href="#course-practice">开始独立练习<ArrowRight size={14} aria-hidden="true" /></a>
      <a className={ui.quiet} href="#course-learning-records"><ClipboardList size={14} aria-hidden="true" />学习记录</a>
      <Link className={ui.quiet} href={opening ? "/opening/library?tab=notes" : "/library/new"}>写笔记</Link>
    </nav>
    <p className="mt-2 text-xs leading-5 text-zinc-500">没有材料也能开始；独立练习与自报记录不需要 AI。课程材料见下方折叠区。</p>
  </section>;
}
