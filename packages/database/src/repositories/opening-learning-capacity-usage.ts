import { spanTutorAutomationSchema, spanTutorBudgetSchema, learningActivityBudgetSchema, type SpanTutorBudget } from "@aistudy/contracts";
import { resolveLocalDayBounds } from "@aistudy/domain";
import { learningError } from "./opening-learning-facts";
type Row = Record<string, unknown>;
const object = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const at = (value: unknown) => value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : NaN;
const conflict = (message: string) => learningError("CONFLICT", message);
const duration = (value: unknown): number => { if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw conflict("已有活动的学习时长无法确认，请先核对活动或手动安排复测。"); return value; };
function overlapsDay(stored: Pick<SpanTutorBudget, "localDate" | "timeZone">, day: Pick<SpanTutorBudget, "localDate" | "timeZone">): boolean {
  const a = resolveLocalDayBounds(stored.localDate, stored.timeZone), b = resolveLocalDayBounds(day.localDate, day.timeZone);
  return a.dayStart < b.nextDayStart && b.dayStart < a.nextDayStart;
}

/** Existing activity/task references own the time; the same reference is never charged twice. */
export function calculateSpanTutorBudgetUsage(day: Pick<SpanTutorBudget, "localDate" | "timeZone">,
  activities: Row[], tasks: Row[], blocks: Row[]): number {
  const { dayStart, nextDayStart } = resolveLocalDayBounds(day.localDate, day.timeZone);
  const inDay = (value: unknown) => at(value) >= dayStart.getTime() && at(value) < nextDayStart.getTime();
  const usage = new Map<string, number>();
  const charge = (key: string, minutes: number) => usage.set(key, Math.max(usage.get(key) ?? 0, duration(minutes)));
  const blockMinutes = new Map<string, number>();
  const intervals = new Map<string, Array<[number, number]>>();
  for (const block of blocks) {
    const start = Math.max(at(block.start), dayStart.getTime()), end = Math.min(at(block.end), nextDayStart.getTime());
    if (!Number.isFinite(start) || !Number.isFinite(end)) throw conflict("已接受安排的日期无法确认，请先核对今日安排。");
    if (end > start) intervals.set(String(block.taskId), [...(intervals.get(String(block.taskId)) ?? []), [start, end]]);
  }
  for (const [id, ranges] of intervals) {
    let previousEnd = -Infinity, minutes = 0;
    for (const [start, end] of ranges.sort((a, b) => a[0] - b[0])) { minutes += Math.max(0, end - Math.max(start, previousEnd)) / 60000; previousEnd = Math.max(previousEnd, end); }
    blockMinutes.set(id, minutes);
  }
  for (const task of tasks) {
    if (task.status === "skipped") continue;
    const key = `task:${task.id}`, scheduledMinutes = blockMinutes.get(String(task.id));
    const protocol = object(task.learning_protocol), stored = spanTutorAutomationSchema.safeParse(protocol.tutorAutomation);
    if (protocol.tutorAutomation != null && !stored.success) throw conflict("已有自动复测的预算记录无法读取，请手动核对原任务。");
    if (scheduledMinutes !== undefined) charge(key, Math.max(duration(task.minutes), scheduledMinutes));
    else if (task.retest_id) {
      const postponed = [task.not_before, task.not_before_at, task.snoozed_until].filter(value => value != null).map(at);
      const target = task.scheduled_start_at ?? task.recommended_at;
      if (postponed.some(value => !Number.isFinite(value)) || (target != null && !Number.isFinite(at(target)))) throw conflict("已接受复测的执行日期无法确认，请先给原任务明确日期或手动安排。");
      if (target != null) {
        if (inDay(new Date(Math.max(at(target), ...postponed)))) charge(key, Math.max(duration(task.minutes), stored.success ? stored.data.minutes : 0));
      } else if (stored.success) {
        const moved = postponed.length && Math.max(...postponed) >= resolveLocalDayBounds(stored.data.localDate, stored.data.timeZone).nextDayStart.getTime();
        if (moved ? inDay(new Date(Math.max(...postponed))) : overlapsDay(stored.data, day)) charge(key, Math.max(duration(task.minutes), stored.data.minutes));
      } else throw conflict("已接受复测的执行日期无法确认，请先给原任务明确日期或手动安排。");
    } else if (inDay(task.due_at)) charge(key, duration(task.minutes));
  }
  // A block must resolve to an actual owned task; otherwise its duration is still reserved.
  for (const [id, minutes] of blockMinutes) if (!tasks.some(task => String(task.id) === id && task.status === "skipped")) charge(`task:${id}`, minutes);
  for (const activity of activities) {
    const goal = object(activity.goal_json), stored = goal.learningBudget != null ? learningActivityBudgetSchema.safeParse(goal.learningBudget) : spanTutorBudgetSchema.safeParse(goal.tutorBudget);
    if (goal.learningBudget != null && !stored.success) throw conflict("已有活动的共同预算记录无法读取，请先核对活动。");
    if (goal.tutorBudget != null && !stored.success) throw conflict("已有活动的预算记录无法读取，请先核对活动。");
    if (!(stored.success ? overlapsDay(stored.data, day) : inDay(activity.created_at))) continue;
    const intent = object(activity.create_intent), checkpoint = object(object(activity.checkpoint_json).spanLesson);
    const linkedTask = intent.taskId ?? (checkpoint.retestId ? tasks.find(task => task.retest_id === checkpoint.retestId || task.candidate_id === checkpoint.retestId || task.candidate_reference_id === checkpoint.retestId)?.id : undefined);
    const minutes = stored.success ? stored.data.minutes : object(intent.intent).timeBudgetMinutes ?? goal.sessionMinutes
      ?? tasks.find(task => task.id === linkedTask)?.minutes;
    const recoveryId = object(goal.recovery).activityId;
    const original = recoveryId ? activities.find(row => row.id === recoveryId && row.course_id === activity.course_id) : undefined;
    charge(linkedTask ? `task:${linkedTask}` : `activity:${original?.id ?? activity.id}`, duration(minutes));
  }
  return [...usage.values()].reduce((sum, minutes) => sum + minutes, 0);
}
