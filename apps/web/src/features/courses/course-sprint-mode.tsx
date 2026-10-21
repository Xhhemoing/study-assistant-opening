"use client";

import Link from "next/link";
import { EmptyState, ui } from "../opening/design/ui";
import { ExamSprintView } from "../opening/exam-sprint/sprint-view";
import type { CourseSummary } from "./course-model";

/** Mounted only after CourseDetail has successfully read the owned course. */
export function CourseSprintMode({ course }: { course: CourseSummary }) {
  const href = `/opening/courses/${encodeURIComponent(course.id)}`;
  return <section className="flex h-full min-h-0 flex-col bg-bg text-text">
    <nav aria-label="冲刺课程" className="border-b border-line px-5 py-3"><Link className={ui.quiet} href={href}>返回 {course.title}</Link></nav>
    <div className="min-h-0 flex-1 overflow-y-auto">{course.archivedAt ? <EmptyState title="课程已归档" description="恢复课程后再进入冲刺，原有记录会继续保留。" action={<Link className={ui.primary} href={href}>查看课程</Link>} /> : <ExamSprintView courseId={course.id} />}</div>
  </section>;
}
