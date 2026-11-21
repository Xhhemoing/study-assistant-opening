"use client";

import { TransitionLink as Link } from "../v3/motion/view-transition";
import { useConversationObjectHref } from "../assistant/conversation-object-context";
import { EmptyState, LoadError, LoadingRows, PageHeader, ui } from "../design/ui";
import { hasStringFields, useJsonList } from "../design/use-json-list";
import { sprintCourseHref } from "./sprint-course-route";
import { SprintQuickStart } from "./sprint-quick-start";

type CourseChoice = { id: string; title: string; archivedAt?: string | null };
const isCourse = (value: unknown): value is CourseChoice => hasStringFields(value, ["id", "title"]);

export function SprintCourseChooser({ invalidCourse = false }: { invalidCourse?: boolean }) {
  const objectHref = useConversationObjectHref();
  const { rows, loading, error, reload } = useJsonList<CourseChoice>("/api/courses", "courses", isCourse);
  const courses = rows.filter(course => !course.archivedAt);
  return <section className="flex min-h-full flex-col bg-bg text-text">
    <PageHeader title="考前冲刺" />
    <div className="mx-auto w-full max-w-[1040px] space-y-5 px-4 py-6 sm:px-6">
      {invalidCourse ? <p className="text-sm text-warn" role="status">原链接中的课程编号无效，请重新选择。</p> : null}
      <SprintQuickStart />
      {loading ? <LoadingRows label="正在读取你的课程…" /> : error ? <LoadError message={error} onRetry={reload} /> : courses.length ? <ul className="divide-y divide-line overflow-hidden rounded-card border border-line bg-surface shadow-card">{courses.map(course => <li key={course.id}><Link className="group flex min-h-14 items-center justify-between gap-4 px-4 py-3.5 text-sm font-medium transition-colors duration-150 hover:bg-surface-2/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent motion-reduce:transition-none" href={objectHref(sprintCourseHref({ courseId: course.id }) ?? "/opening/courses")}><span className="min-w-0 truncate text-text">{course.title}</span><span className="shrink-0 text-xs font-medium text-text-2 transition-colors group-hover:text-accent">进入冲刺</span></Link></li>)}</ul> : <EmptyState title="还没有进行中的课程" description="创建课程后可关联冲刺题包，或恢复一门已归档课程。" action={<Link className={ui.primary} href="/opening/courses">查看课程</Link>} />}
    </div>
  </section>;
}
