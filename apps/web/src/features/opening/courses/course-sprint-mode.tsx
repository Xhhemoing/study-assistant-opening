"use client";

import { TransitionLink as Link } from "../v3/motion/view-transition";
import { useConversationObjectHref } from "../assistant/conversation-object-context";
import { EmptyState, ui } from "../design/ui";
import { CourseSprintPack } from "../exam-sprint/course-sprint-pack";
import { SprintBoard } from "../exam-sprint/sprint-board";
import type { CourseSummary } from "./course-model";

/** Mounted only after CourseDetail has successfully read the owned course. */
export function CourseSprintMode({ course }: { course: CourseSummary }) {
  const objectHref = useConversationObjectHref();
  const coursePath = `/opening/courses/${encodeURIComponent(course.id)}`;
  const href = objectHref(coursePath);
  return <section className="flex h-full min-h-0 flex-col bg-bg text-text">
    <nav aria-label="冲刺课程" className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3">
      <Link className={ui.quiet} href={href}>返回 {course.title}</Link>
      {!course.archivedAt ? <>
        <Link className={ui.secondary} href={objectHref(`${coursePath}/exam`)}>真题与考前练习</Link>
        <Link className={ui.quiet} href={objectHref(`${coursePath}?tab=units#course-learning-route`)}>全课路线</Link>
        <a className={ui.quiet} href="#course-sprint-plan">查看今日计划</a>
      </> : null}
    </nav>
    <div className="min-h-0 flex-1 overflow-y-auto">
      {course.archivedAt
        ? <EmptyState title="课程已归档" description="恢复课程后再进入冲刺，原有记录会继续保留。" action={<Link className={ui.primary} href={href}>查看课程</Link>} />
        : <CourseSprintPack key={`${course.workspaceId}:${course.id}`} workspaceId={course.workspaceId} courseId={course.id}>
          <div id="course-sprint-plan" tabIndex={-1}>
            <SprintBoard courseId={course.id} courseTitle={course.title} />
          </div>
        </CourseSprintPack>}
    </div>
  </section>;
}
