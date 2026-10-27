import { ArrowUpRight, MoreHorizontal } from "lucide-react";
import { TransitionLink as Link } from "../v3/motion/view-transition";
import { ui } from "../design/ui";
import type { TodayCourse } from "./today-read";

export function TodayCourseList({ courses }: { courses: TodayCourse[] }) {
  return <section aria-label="我的课程" className="px-5 py-4 group-data-[focus=true]/workspace:hidden">
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-sm font-semibold">我的课程</h2>
      <Link href="/opening/courses?view=all" className={ui.quiet}>全部课程</Link>
    </div>
    {courses.length ? <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
      {courses.map(course => <li key={course.id} className="flex items-center gap-1 pr-2">
        <Link href={`/opening/courses/${encodeURIComponent(course.id)}`} className="flex min-h-14 min-w-0 flex-1 items-center justify-between gap-3 rounded-xl px-4 py-3 text-sm hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
          <span className="min-w-0"><span className="block truncate font-medium">{course.title}</span>{course.archivedAt ? <span className="text-xs text-text-3">已归档 · 可恢复</span> : null}</span>
          <ArrowUpRight size={15} aria-hidden="true" className="shrink-0 text-text-3" />
        </Link>
        {!course.archivedAt && course.learningMode === "exam" && course.targetDate ? <details className="relative shrink-0">
          <summary aria-label={`${course.title}更多操作`} className="flex min-h-11 min-w-11 cursor-pointer list-none items-center justify-center rounded-lg text-text-2 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent [&::-webkit-details-marker]:hidden"><MoreHorizontal size={18} aria-hidden="true" /></summary>
          <div className="absolute right-0 top-full z-10 min-w-32 rounded-lg border border-line bg-surface p-1 shadow-lg"><Link href={`/opening/sprint?courseId=${encodeURIComponent(course.id)}`} className={`${ui.quiet} w-full whitespace-nowrap`}>考前冲刺</Link></div>
        </details> : null}
      </li>)}
    </ul> : null}
  </section>;
}
