import { useState } from "react";
import type { ExamSprintOverview } from "@aistudy/contracts";
import { ui } from "../design/ui";
import { sprintLessonUnavailableReason, type LessonReturnTarget, type OpenSprintLesson } from "./lesson-navigation";

export function LessonButton({ overview, lessonId, onOpenLesson, returnTarget, label = "查看对应串讲", disabled = false }: {
  overview: ExamSprintOverview;
  lessonId: string | null;
  onOpenLesson: OpenSprintLesson;
  returnTarget: LessonReturnTarget;
  label?: string;
  disabled?: boolean;
}) {
  const [confirm, setConfirm] = useState(false);
  const reason = sprintLessonUnavailableReason(overview, lessonId);
  const mock = overview.activeRun?.mode.startsWith("mock");
  return <div className="min-w-0 max-w-full space-y-1"><button type="button" className={`${ui.quiet} max-w-full whitespace-normal text-left`} disabled={disabled || !!reason} onClick={() => { if (mock) setConfirm(true); else void onOpenLesson(lessonId, returnTarget); }}>{mock ? "结束本次计分模拟并转教学" : label}</button>{reason ? <p className="text-xs leading-6 text-text-3">{reason}。</p> : null}
    {mock && confirm ? <div className="space-y-2 rounded-lg border border-line p-3" role="group" aria-label="确认转教学"><p className="text-sm leading-6 text-text-2">将停止本次计时并保留原始记录与已提交答案。本题记为受助和曝光，未答题保持未答；不能续卷或重开同套模拟。这是转教学提前结束，非完整独立模考。</p><div className="flex flex-wrap gap-2"><button type="button" className={ui.secondary} disabled={disabled || !!reason} onClick={() => { void onOpenLesson(lessonId, returnTarget, true); }}>确认结束计分并阅读串讲</button><button type="button" className={ui.quiet} disabled={disabled} onClick={() => setConfirm(false)}>继续模拟</button></div></div> : null}</div>;
}
