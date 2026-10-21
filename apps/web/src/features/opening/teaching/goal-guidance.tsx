import type { TeachingLearnerFocus } from "@aistudy/contracts";

/** A concise explanation of the activity's saved teaching intention, not a mastery claim. */
export function TeachingGoalGuidance({ focus }: { focus?: TeachingLearnerFocus }) {
  const goal = focus?.goalContext;
  if (!goal) return null;
  const repair = focus.prerequisiteRepair;
  return <aside className="rounded-lg bg-surface-2 px-3 py-2 text-xs leading-6 text-text-2" aria-label="本次学习安排">
    <p className="font-medium text-text">{goal.mode === "exam" ? "本次以练习和必要讲解为主" : "本次侧重理解与迁移"}</p>
    {goal.reasonCode === "deadline_near" ? <p>{goal.daysRemaining === 0 ? "创建本次活动时，目标当天到期" : `创建本次活动时，距离目标还有 ${goal.daysRemaining} 天`}，优先解决当前任务的关键步骤。</p> : null}
    {repair ? <details className="mt-1">
      <summary className="min-h-11 cursor-pointer py-2">建议先补 {repair.skillLabel}，再回到 {repair.returnToSkillLabel}</summary>
      <p>{repair.reason}</p>
      <p>建议用约 {repair.maxMinutes} 分钟补习。{repair.stopCondition}</p>
    </details> : null}
  </aside>;
}
