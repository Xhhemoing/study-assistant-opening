import { TransitionLink as Link } from "../v3/motion/view-transition";
import { BookOpen } from "lucide-react";
import type { ReactNode } from "react";
import type { LearningResume } from "@aistudy/contracts";
import { unitProgress } from "../teaching/unit-progress";
import { ui } from "../design/ui";
import type { TodayCourse, TodayResumeState } from "./today-read";
import { todayCourseGoalSummary } from "./today-course-goal";
import { continueMathObject, ContinueMathPreview } from "./continue-math-preview";

type ActivityContext = { title: string; courseId: string | null; id?: string; contentVersion?: number };

/** Position is a reading checkpoint, never an inferred completion/mastery score. */
export function continuePosition(activity: ActivityContext | null | undefined, resume?: LearningResume | null) {
  if (typeof resume?.clientInit?.checkpointJson?.currentBlockId !== "string") return null;
  return unitProgress(activity, resume);
}

export function ContinueCard({ item, activity, courseTitle, course, timeZone, resume, primaryAction, secondaryAction, finished, estimateMinutes }: {
  estimateMinutes?: number | null;
  /** 今天在当前课程里已学完的最近一节（没有进行中的小节时才展示）。 */
  finished?: { title: string; count: number } | null;
  item?: TodayResumeState["continueItem"];
  activity?: ActivityContext | null;
  resume?: LearningResume | null;
  courseTitle?: string | null;
  course?: TodayCourse | null;
  timeZone?: string;
  primaryAction?: ReactNode;
  secondaryAction?: ReactNode;
}) {
  const courseId = activity ? activity.courseId : item ? item.courseId : course?.id;
  const currentCourse = course?.id === courseId ? course : null;
  const goalSummary = todayCourseGoalSummary(currentCourse, timeZone);
  const title = currentCourse?.title ?? courseTitle;
  const position = continuePosition(activity, resume);
  const math = continueMathObject(activity, resume);
  const sourceCount = Object.keys(item?.sourceVersions ?? {}).length;
  const done = !activity && currentCourse && finished ? finished : null;
  return <article aria-label="继续学习" className="rounded-panel border border-line bg-surface p-5 shadow-card transition-[border-color,box-shadow] duration-200 ease-out-strong hover:border-line-strong sm:p-6" data-continue-card="true">
    <div className="flex items-start gap-4">
      <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent ring-1 ring-inset ring-accent/15"><BookOpen size={20} aria-hidden="true" /></span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-3">
          <span className="tabular-nums">{activity ? "继续这一节" : done ? (done.count > 1 ? `今天已学完 ${done.count} 节` : "今天已学完一节") : item ? "上次保存的对话" : "你的学习起点"}</span>
          {courseId && title ? <><span aria-hidden="true">·</span><span className="font-medium text-accent">{title}</span></> : null}
          {estimateMinutes != null ? <><span aria-hidden="true">·</span><span className="tabular-nums">预计 {estimateMinutes} 分钟</span></> : null}
        </div>
        <h2 className="mt-1.5 break-words font-serif text-[21px] leading-[1.45] font-medium tracking-[-0.015em] text-text sm:text-[22px]">{activity ? `继续学习：${activity.title}` : done ? `已学完：${done.title}` : item ? `上次对话：${item.title}` : currentCourse ? "今天先学一个小节" : "从一个问题、一次练习或一篇笔记开始"}</h2>
        {done ? <p className="mt-2 text-sm leading-6 text-text-2">可以接着学下一节，或者先复习刚学的内容。</p> : null}
        {goalSummary ? <p className="mt-2 text-sm leading-6 text-text-2">{goalSummary}</p> : null}
        {position ? <div className="mt-3.5 space-y-2"><p className="text-xs tabular-nums text-text-2">上次停在第 {position.current} / {position.total} 单元</p><progress className="h-1.5 w-full max-w-80 overflow-hidden rounded-full accent-accent [&::-webkit-progress-bar]:bg-surface-2 [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-accent [&::-moz-progress-bar]:bg-accent" aria-label="上次阅读位置" value={position.current} max={position.total} /></div> : null}
        {!activity && item ? <p className="mt-2 text-xs leading-6 tabular-nums text-text-2">{item.currentPage ? `上次读到第 ${item.currentPage} 页` : "可继续上次保存的对话"}{sourceCount ? ` · 可恢复 ${sourceCount} 份材料` : ""}</p> : null}
        {!activity && item?.manualSourceCount ? <p className="mt-1 text-xs leading-5 tabular-nums text-text-3">{item.manualSourceCount} 份材料仅供手工阅读，已停止供 AI 使用；可在材料页查看。</p> : null}
        {math ? <ContinueMathPreview object={math} /> : null}
        <div className="mt-5 flex flex-wrap items-center gap-2.5">{primaryAction}{secondaryAction}<Link href={courseId ? `/opening/courses/${encodeURIComponent(courseId)}` : "/opening/courses"} className={ui.quiet}>{courseId ? "回到关联课程" : "课程与自主练习"}</Link></div>
      </div>
    </div>
  </article>;
}
