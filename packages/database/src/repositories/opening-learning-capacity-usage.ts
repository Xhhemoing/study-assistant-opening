import { spanTutorAutomationSchema, spanTutorBudgetSchema, learningActivityBudgetSchema, type SpanTutorBudget } from "@aistudy/contracts";
import { evaluateDayExceptionCapacity, resolveLocalDayBounds, straddlingUsageBounds } from "@aistudy/domain";
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

export type DayExceptionUsageBounds = {
  dayUsedMinutes: number;
  afterLowerMinutes: number;
  afterUpperMinutes: number;
};

/**
 * Splits a day's committed usage into total day usage (Sday) and post-effectiveAt
 * [afterLowerMinutes, afterUpperMinutes] bounds (Safter) so activities straddling
 * effectiveAt with only total duration are bounded honestly without guessing.
 */
export function calculateDayExceptionUsageBounds(
  day: Pick<SpanTutorBudget, "localDate" | "timeZone">,
  effectiveAtIso: string,
  activities: Row[],
  tasks: Row[],
  blocks: Row[],
  options: { excludeTaskIds?: ReadonlySet<string> } = {},
): DayExceptionUsageBounds {
  const { dayStart, nextDayStart } = resolveLocalDayBounds(day.localDate, day.timeZone);
  const effectiveAtMs = Date.parse(effectiveAtIso);
  if (!Number.isFinite(effectiveAtMs)) throw conflict("当日临时调整的生效时间无效。");
  const exclude = options.excludeTaskIds ?? new Set<string>();
  const inDay = (value: unknown) => at(value) >= dayStart.getTime() && at(value) < nextDayStart.getTime();

  const totalByKey = new Map<string, number>();
  const afterLowerByKey = new Map<string, number>();
  const afterUpperByKey = new Map<string, number>();

  const charge = (key: string, total: number, minAfter: number, maxAfter: number) => {
    const safeTotal = duration(total);
    totalByKey.set(key, Math.max(totalByKey.get(key) ?? 0, safeTotal));
    afterLowerByKey.set(key, Math.max(afterLowerByKey.get(key) ?? 0, Math.max(0, Math.min(safeTotal, minAfter))));
    afterUpperByKey.set(key, Math.max(afterUpperByKey.get(key) ?? 0, Math.max(0, Math.min(safeTotal, maxAfter))));
  };

  const intervals = new Map<string, Array<[number, number]>>();
  for (const block of blocks) {
    const taskId = String(block.taskId);
    const start = Math.max(at(block.start), dayStart.getTime());
    const end = Math.min(at(block.end), nextDayStart.getTime());
    if (!Number.isFinite(start) || !Number.isFinite(end)) throw conflict("已接受安排的日期无法确认，请先核对今日安排。");
    if (end > start) intervals.set(taskId, [...(intervals.get(taskId) ?? []), [start, end]]);
  }

  const blockStats = new Map<string, { total: number; after: number }>();
  for (const [id, ranges] of intervals) {
    let previousEnd = -Infinity;
    let totalMinutes = 0;
    let afterMinutes = 0;
    for (const [start, end] of ranges.sort((a, b) => a[0] - b[0])) {
      const mergedStart = Math.max(start, previousEnd);
      if (end > mergedStart) {
        totalMinutes += (end - mergedStart) / 60_000;
        const postStart = Math.max(mergedStart, effectiveAtMs);
        if (end > postStart) afterMinutes += (end - postStart) / 60_000;
        previousEnd = end;
      }
    }
    blockStats.set(id, { total: totalMinutes, after: afterMinutes });
  }

  for (const task of tasks) {
    if (task.status === "skipped") continue;
    const taskId = String(task.id);
    const key = `task:${taskId}`;
    const scheduled = blockStats.get(taskId);
    const protocol = object(task.learning_protocol);
    const stored = spanTutorAutomationSchema.safeParse(protocol.tutorAutomation);
    if (protocol.tutorAutomation != null && !stored.success) throw conflict("已有自动复测的预算记录无法读取，请手动核对原任务。");
    if (scheduled !== undefined) {
      const total = Math.max(duration(task.minutes), scheduled.total);
      const extra = Math.max(0, total - scheduled.total);
      charge(key, total, scheduled.after, scheduled.after + extra);
      continue;
    }
    if (exclude.has(taskId)) continue;
    if (task.status === "done") {
      const updatedMs = at(task.updated_at);
      const createdMs = at(task.created_at);
      if (inDay(task.updated_at) || inDay(task.due_at)) {
        const minutes = duration(task.minutes);
        const bounds = straddlingUsageBounds({
          minutes,
          startMs: Number.isFinite(createdMs) ? createdMs : null,
          endMs: Number.isFinite(updatedMs) ? updatedMs : null,
          effectiveAtMs,
        });
        charge(key, minutes, bounds.minAfter, bounds.maxAfter);
      }
      continue;
    }
    if (task.retest_id) {
      const postponed = [task.not_before, task.not_before_at, task.snoozed_until].filter(value => value != null).map(at);
      const target = task.scheduled_start_at ?? task.recommended_at;
      if (postponed.some(value => !Number.isFinite(value)) || (target != null && !Number.isFinite(at(target)))) {
        throw conflict("已接受复测的执行日期无法确认，请先给原任务明确日期或手动安排。");
      }
      if (target != null) {
        const targetMs = Math.max(at(target), ...postponed);
        if (inDay(new Date(targetMs))) {
          const minutes = Math.max(duration(task.minutes), stored.success ? stored.data.minutes : 0);
          const after = targetMs >= effectiveAtMs ? minutes : 0;
          charge(key, minutes, after, minutes);
        }
      } else if (stored.success) {
        const moved = postponed.length && Math.max(...postponed) >= resolveLocalDayBounds(stored.data.localDate, stored.data.timeZone).nextDayStart.getTime();
        if (moved ? inDay(new Date(Math.max(...postponed))) : overlapsDay(stored.data, day)) {
          const minutes = Math.max(duration(task.minutes), stored.data.minutes);
          charge(key, minutes, 0, minutes);
        }
      }
    } else if (inDay(task.due_at)) {
      charge(key, duration(task.minutes), 0, 0);
    }
  }

  for (const [id, stat] of blockStats) {
    if (!tasks.some(task => String(task.id) === id && task.status === "skipped")) {
      charge(`task:${id}`, stat.total, stat.after, stat.after);
    }
  }

  for (const activity of activities) {
    const goal = object(activity.goal_json);
    const stored = goal.learningBudget != null
      ? learningActivityBudgetSchema.safeParse(goal.learningBudget)
      : spanTutorBudgetSchema.safeParse(goal.tutorBudget);
    if (goal.learningBudget != null && !stored.success) throw conflict("已有活动的共同预算记录无法读取，请先核对活动。");
    if (goal.tutorBudget != null && !stored.success) throw conflict("已有活动的预算记录无法读取，请先核对活动。");
    if (!(stored.success ? overlapsDay(stored.data, day) : inDay(activity.created_at))) continue;
    const intent = object(activity.create_intent);
    const checkpoint = object(activity.checkpoint_json);
    const spanLesson = object(checkpoint.spanLesson);
    const cardSession = object(checkpoint.cardReviewSession);
    const linkedTask = intent.taskId ?? (spanLesson.retestId
      ? tasks.find(task => task.retest_id === spanLesson.retestId || task.candidate_id === spanLesson.retestId || task.candidate_reference_id === spanLesson.retestId)?.id
      : undefined);
    if (linkedTask && !blockStats.has(String(linkedTask)) && exclude.has(String(linkedTask))) continue;
    const minutes = stored.success
      ? stored.data.minutes
      : object(intent.intent).timeBudgetMinutes ?? goal.sessionMinutes ?? tasks.find(task => task.id === linkedTask)?.minutes;
    const recoveryId = object(goal.recovery).activityId;
    const original = recoveryId ? activities.find(row => row.id === recoveryId && row.course_id === activity.course_id) : undefined;
    const key = linkedTask ? `task:${linkedTask}` : `activity:${original?.id ?? activity.id}`;

    const startMs = at(activity.created_at);
    const stoppedMs = at(cardSession.stoppedAt);
    const isFinished = ["completed", "cancelled", "stopped", "archived"].includes(String(activity.status ?? ""));
    const updatedMs = at(activity.updated_at);
    const endMs = Number.isFinite(stoppedMs)
      ? stoppedMs
      : isFinished && Number.isFinite(updatedMs)
        ? updatedMs
        : null;

    const bounds = straddlingUsageBounds({
      minutes: duration(minutes),
      startMs: Number.isFinite(startMs) ? startMs : null,
      endMs,
      effectiveAtMs,
    });
    charge(key, duration(minutes), bounds.minAfter, bounds.maxAfter);
  }

  return {
    dayUsedMinutes: [...totalByKey.values()].reduce((sum, minutes) => sum + minutes, 0),
    afterLowerMinutes: [...afterLowerByKey.values()].reduce((sum, minutes) => sum + minutes, 0),
    afterUpperMinutes: [...afterUpperByKey.values()].reduce((sum, minutes) => sum + minutes, 0),
  };
}

/**
 * Evaluates post-replacement capacity for a calendar day under daily budget (D - B)
 * and an optional active day-exception ceiling (remainingMinutes after effectiveAt).
 */
export function evaluateDayPlanCapacity(input: {
  day: Pick<SpanTutorBudget, "localDate" | "timeZone">;
  budget: { dailyMinutes: number; bufferMinutes: number } | null;
  dayException: { effectiveAt: string; remainingMinutes: number } | null;
  activities: Row[];
  tasks: Row[];
  afterBlocks: readonly { taskId: string; start: string; end: string }[];
  excludeTaskIds?: ReadonlySet<string>;
}) {
  const { dayStart, nextDayStart } = resolveLocalDayBounds(input.day.localDate, input.day.timeZone);
  const effectiveAtIso = input.dayException ? input.dayException.effectiveAt : dayStart.toISOString();
  const effectiveAtMs = Date.parse(effectiveAtIso);
  const afterBlockTaskIds = new Set(input.afterBlocks.map((block) => block.taskId));
  const exclude = new Set(
    [...(input.excludeTaskIds ?? [])].filter((taskId) => !afterBlockTaskIds.has(taskId)),
  );

  const postRanges: Array<[number, number]> = [];
  for (const block of input.afterBlocks) {
    const start = Math.max(Date.parse(block.start), effectiveAtMs, dayStart.getTime());
    const end = Math.min(Date.parse(block.end), nextDayStart.getTime());
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      postRanges.push([start, end]);
    }
  }
  let previousEnd = -Infinity;
  let requiredMinutes = 0;
  for (const [start, end] of postRanges.sort((a, b) => a[0] - b[0])) {
    const mergedStart = Math.max(start, previousEnd);
    if (end > mergedStart) {
      requiredMinutes += (end - mergedStart) / 60_000;
      previousEnd = end;
    }
  }

  const allBounds = calculateDayExceptionUsageBounds(
    input.day,
    effectiveAtIso,
    input.activities,
    input.tasks,
    input.afterBlocks as unknown as Row[],
    { excludeTaskIds: exclude },
  );

  return evaluateDayExceptionCapacity({
    dailyMinutes: input.budget?.dailyMinutes ?? null,
    bufferMinutes: input.budget?.bufferMinutes ?? null,
    dayUsedMinutes: Math.max(0, allBounds.dayUsedMinutes - requiredMinutes),
    exceptionRemainingMinutes: input.dayException?.remainingMinutes ?? null,
    afterLowerMinutes: input.dayException ? Math.max(0, allBounds.afterLowerMinutes - requiredMinutes) : 0,
    afterUpperMinutes: input.dayException ? Math.max(0, allBounds.afterUpperMinutes - requiredMinutes) : 0,
    requiredMinutes,
  });
}
