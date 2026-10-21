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
  const reason = sprintLessonUnavailableReason(overview, lessonId);
  return <div className="min-w-0 max-w-full space-y-1"><button type="button" className={`${ui.quiet} max-w-full whitespace-normal text-left`} disabled={disabled || !!reason} onClick={() => { void onOpenLesson(lessonId, returnTarget); }}>{label}</button>{reason ? <p className="text-xs leading-6 text-text-3">{reason}。</p> : null}</div>;
}
