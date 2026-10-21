import Link from "next/link";
import { BookOpen } from "lucide-react";
import type { ReactNode } from "react";
import type { LearningResume } from "@aistudy/contracts";
import { ui } from "../design/ui";
import type { TodayResumeState } from "./today-read";

type ActivityContext = { title: string; courseId: string | null; id?: string; contentVersion?: number };

/** Position is a reading checkpoint, never an inferred completion/mastery score. */
export function continuePosition(activity: ActivityContext | null | undefined, resume?: LearningResume | null) {
  if (!activity?.id || !resume || resume.activityId !== activity.id || resume.contentVersion !== activity.contentVersion || !resume.clientInit || resume.clientInit.contentVersion !== resume.contentVersion) return null;
  const steps = [...resume.clientInit.blockOrder].filter(block => block.role !== "answer_key" && block.blockType !== "answer_key").sort((a, b) => a.position - b.position);
  const index = steps.findIndex(block => block.blockId === resume.thoughtTrain.currentBlockId);
  return index < 0 ? null : { current: index + 1, total: steps.length };
}

export function ContinueCard({ item, activity, resume, primaryAction, secondaryAction }: {
  item?: TodayResumeState["continueItem"];
  activity?: ActivityContext | null;
  resume?: LearningResume | null;
  primaryAction?: ReactNode;
  secondaryAction?: ReactNode;
}) {
  const courseId = activity?.courseId ?? item?.courseId;
  const position = continuePosition(activity, resume);
  const sourceCount = Object.keys(item?.sourceVersions ?? {}).length;
  return <article aria-label="继续学习" className="rounded-2xl border border-line bg-surface px-5 py-5 shadow-sm transition-transform duration-200 motion-safe:hover:-translate-y-0.5 motion-reduce:transition-none" data-continue-card="true">
    <div className="flex items-start gap-4">
      <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent"><BookOpen size={22} aria-hidden="true" /></span>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-text-3">{activity ? "继续这一节" : item ? "上次保存的对话" : "你的学习起点"}</p>
        <h2 className="mt-1 break-words font-serif text-xl leading-8 text-text">{activity ? `继续学习：${activity.title}` : item ? `上次对话：${item.title}` : "从一个问题、一次练习或一篇笔记开始"}</h2>
        {position ? <div className="mt-3 space-y-2"><p className="text-xs text-text-2">上次停在第 {position.current} / {position.total} 步</p><progress className="h-1 w-full max-w-80 overflow-hidden rounded-full accent-accent [&::-webkit-progress-bar]:bg-surface-2 [&::-webkit-progress-value]:bg-accent [&::-moz-progress-bar]:bg-accent" aria-label="上次阅读位置" value={position.current} max={position.total} /></div> : null}
        {!activity && item ? <p className="mt-2 text-xs leading-6 text-text-2">{item.currentPage ? `上次读到第 ${item.currentPage} 页` : "可继续上次保存的对话"}{sourceCount ? ` · 可恢复 ${sourceCount} 份材料` : ""}</p> : null}
        {!activity && item?.manualSourceCount ? <p className="mt-1 text-xs leading-5 text-text-3">{item.manualSourceCount} 份材料仅供手工阅读，已停止供 AI 使用；可在材料页查看。</p> : null}
        <div className="mt-4 flex flex-wrap items-center gap-2">{primaryAction}{secondaryAction}<Link href={courseId ? `/opening/courses/${encodeURIComponent(courseId)}` : "/opening/courses"} className={ui.quiet}>{courseId ? "回到关联课程" : "课程与自主练习"}</Link></div>
      </div>
    </div>
  </article>;
}
