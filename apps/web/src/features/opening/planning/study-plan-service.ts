import type { Sql } from "postgres";
import {
  courseStudyPlanInputSchema,
  type CourseStudyPlanLesson,
  type CourseStudyPlanView,
  type Scope,
  type SourceChunk,
  type StudyPlanSettings,
} from "@aistudy/contracts";
import {
  createOpeningAdaptivePrefsRepository,
  createOpeningPlanningSettingsRepository,
  createOpeningSourceChunksRepository,
  createOpeningStudyPlansRepository,
  listReadySourceIdsForCourse,
  type StudyPlanTaskInput,
  type StudyPlanTaskRow,
} from "@aistudy/database";
import { localDateKeyInZone, planStudyDay, projectStudyPlan, type StudyLessonProgress } from "@aistudy/domain";
import { splitMaterialIntoLessons, type MaterialLesson } from "@aistudy/ai";

/** Material a review lesson brings back at most (the lesson prompt's evidence budget). */
const REVIEW_MATERIAL_CHARACTERS = 5500;
const LESSON_PRIORITY = 2;
const REVIEW_PRIORITY = 3;
/** Same default as the plan service (planning settings without a time zone). */
const DEFAULT_TIME_ZONE = "Asia/Shanghai";

type CourseMaterial = { lessons: MaterialLesson[]; chunks: Map<string, SourceChunk> };

/** When each lesson was first fully taught and last revisited, from completed lessons' citations. */
export function lessonProgress(lessons: readonly MaterialLesson[], taughtDays: ReadonlyMap<string, readonly string[]>): StudyLessonProgress[] {
  return lessons.map((lesson) => {
    const days = lesson.chunkIds.map((id) => taughtDays.get(id) ?? []);
    const taughtOn = days.length && days.every((list) => list.length) ? days.map((list) => list[0]!).sort().at(-1)! : null;
    const later = taughtOn ? days.flat().filter((day) => day > taughtOn).sort() : [];
    return { index: lesson.index, taughtOn, lastReviewedOn: later.at(-1) ?? null };
  });
}

function pageRange(pages: ReadonlyArray<number | null>): { from: number | null; to: number | null } {
  const known = pages.filter((page): page is number => page != null);
  return known.length ? { from: Math.min(...known), to: Math.max(...known) } : { from: null, to: null };
}

function pagesLabel(pages: ReadonlyArray<number | null>): string {
  const { from, to } = pageRange(pages);
  return from == null ? "" : from === to ? `（第 ${from} 页）` : `（第 ${from}–${to} 页）`;
}

export function lessonTaskTitle(courseTitle: string, lesson: MaterialLesson): string {
  return `${courseTitle} · 第 ${lesson.index + 1} 课：${lesson.title}${pagesLabel(lesson.pages)}`.slice(0, 240);
}

export function reviewTaskTitle(courseTitle: string, lessonIndexes: readonly number[], mistakes: number): string {
  const lessons = lessonIndexes.length ? `第 ${lessonIndexes.map((index) => index + 1).join("、")} 课` : "";
  const wrong = mistakes ? `${lessons ? " + " : ""}${mistakes} 道错题` : "";
  return `${courseTitle} · 复习：${lessons}${wrong}`.slice(0, 240);
}

export function reviewNote(mistakes: readonly { question: string }[]): string | undefined {
  if (!mistakes.length) return undefined;
  return [
    "学习者上次答错了下面这些题。先针对它们各出一道类似的新题检查是否已经掌握，再复习其余要点：",
    ...mistakes.map((mistake, index) => `${index + 1}. ${mistake.question}`),
  ].join("\n").slice(0, 2000);
}

/** Distinct later days a lesson's material came back (its reviews so far). */
export function lessonReviewCount(lesson: MaterialLesson, taughtOn: string | null, taughtDays: ReadonlyMap<string, readonly string[]>): number {
  if (!taughtOn) return 0;
  return new Set(lesson.chunkIds.flatMap((id) => taughtDays.get(id) ?? []).filter((day) => day > taughtOn)).size;
}

/** Rotate a lesson's pages so each review starts further in; near-empty pages (covers) go last. */
export function rotateForReview(chunkIds: readonly string[], chunks: ReadonlyMap<string, { text: string }>, reviews: number): string[] {
  const substantive = chunkIds.filter((id) => (chunks.get(id)?.text.replace(/\s+/g, "").length ?? 0) >= 200);
  const thin = chunkIds.filter((id) => !substantive.includes(id));
  const offset = substantive.length ? reviews % substantive.length : 0;
  return [...substantive.slice(offset), ...substantive.slice(0, offset), ...thin];
}

/**
 * Review material within budget: the mistakes' material first, then the due lessons
 * taken a page at a time in turn, so every due lesson is represented.
 */
export function reviewChunkIds(
  chunks: ReadonlyMap<string, { text: string }>,
  groups: ReadonlyArray<readonly string[]>,
  maxCharacters = REVIEW_MATERIAL_CHARACTERS,
): string[] {
  const picked = new Set<string>();
  let size = 0;
  const longest = Math.max(0, ...groups.map((group) => group.length));
  for (let round = 0; round < longest; round += 1) {
    for (const group of groups) {
      const id = group[round];
      const chunk = id ? chunks.get(id) : undefined;
      if (!id || !chunk || picked.has(id)) continue;
      const length = chunk.text.length + 200;
      if (picked.size && size + length > maxCharacters) continue;
      picked.add(id);
      size += length;
    }
  }
  return [...picked];
}

export function createOpeningStudyPlanService(sql: Sql, options: { now?: () => Date } = {}) {
  const plans = createOpeningStudyPlansRepository(sql);
  const prefs = createOpeningAdaptivePrefsRepository(sql);

  async function loadMaterial(scope: Scope, courseId: string): Promise<CourseMaterial> {
    const sourceIds = await listReadySourceIdsForCourse(sql, scope, courseId);
    const chunks = sourceIds.length ? await createOpeningSourceChunksRepository(sql).listForSources(scope, sourceIds) : [];
    return { lessons: splitMaterialIntoLessons(chunks, sourceIds), chunks: new Map(chunks.map((chunk) => [chunk.id, chunk])) };
  }

  async function progressFor(scope: Scope, courseId: string, material: CourseMaterial, timeZone: string) {
    const taughtDays = await plans.taughtDaysByChunk(scope, courseId, timeZone);
    return { progress: lessonProgress(material.lessons, taughtDays), taughtDays };
  }

  /** Build one day's tasks for a course: due review (with open mistakes) first, then new lessons. */
  async function buildDay(scope: Scope, courseId: string, plan: StudyPlanSettings, date: string, timeZone: string, existing: StudyPlanTaskRow[]): Promise<StudyPlanTaskInput[]> {
    const material = await loadMaterial(scope, courseId);
    if (!material.lessons.length) return [];
    const [{ progress, taughtDays }, mistakes, title] = await Promise.all([
      progressFor(scope, courseId, material, timeZone),
      plans.openMistakes(scope, courseId),
      plans.courseTitle(scope, courseId),
    ]);
    const pending = existing.filter((task) => task.status === "pending");
    const slots = planStudyDay({
      date,
      lessonsPerDay: plan.lessonsPerDay,
      lessons: progress,
      reservedLessonIndexes: pending.filter((task) => task.slot.kind === "lesson").flatMap((task) => task.slot.lessonIndexes),
      carryOver: pending.length,
      openMistakes: mistakes.length,
    });
    const courseTitle = title ?? "课程";
    const tasks: StudyPlanTaskInput[] = [];
    if (slots.review) {
      const lessonIndexes = slots.review.lessonIndexes;
      const note = reviewNote(mistakes);
      tasks.push({
        clientKey: `study-plan:${courseId}:${date}:0`,
        title: reviewTaskTitle(courseTitle, lessonIndexes, mistakes.length),
        minutes: plan.lessonMinutes,
        priority: REVIEW_PRIORITY,
        slot: {
          v: 1, kind: "review", localDate: date, lessonIndexes,
          chunkIds: reviewChunkIds(material.chunks, [
            ...mistakes.map((m) => m.chunkIds),
            ...lessonIndexes.map((index) => rotateForReview(material.lessons[index]!.chunkIds, material.chunks, lessonReviewCount(material.lessons[index]!, progress[index]!.taughtOn, taughtDays))),
          ]),
          ...(note ? { note } : {}),
        },
      });
    }
    for (const index of slots.lessonIndexes) {
      const lesson = material.lessons[index]!;
      tasks.push({
        clientKey: `study-plan:${courseId}:${date}:${tasks.length + 1}`,
        title: lessonTaskTitle(courseTitle, lesson),
        minutes: plan.lessonMinutes,
        // Planners order equal priorities by id; keep the material's order instead.
        priority: LESSON_PRIORITY - tasks.length / 100,
        slot: { v: 1, kind: "lesson", localDate: date, lessonIndexes: [index], chunkIds: lesson.chunkIds },
      });
    }
    return tasks;
  }

  return {
    /**
     * Adds the day's lessons for every course with a study plan, once per course and
     * day. Only for today or later; past days are never back-filled.
     */
    async ensureDay(scope: Scope, date: string, today: string, timeZone: string): Promise<number> {
      if (date < today) return 0;
      const { prefs: current } = await prefs.get(scope);
      let added = 0;
      for (const [courseId, goal] of Object.entries(current.courseGoals)) {
        const plan = goal.studyPlan;
        if (!plan || plan.startDate > date) continue;
        added += await plans.issueDay(scope, courseId, date, (existing) => buildDay(scope, courseId, plan, date, timeZone, existing));
      }
      return added;
    },

    /** The view for the learner's current local day (planning settings' time zone). */
    async getCurrentView(scope: Scope, courseId: string): Promise<CourseStudyPlanView> {
      const preference = await createOpeningPlanningSettingsRepository(sql).get(scope);
      const timeZone = preference.settings?.timeZone ?? DEFAULT_TIME_ZONE;
      return this.getView(scope, courseId, localDateKeyInZone(options.now?.() ?? new Date(), timeZone), timeZone);
    },

    async getView(scope: Scope, courseId: string, today: string, timeZone: string): Promise<CourseStudyPlanView> {
      const { prefs: current } = await prefs.get(scope);
      const goal = current.courseGoals[courseId];
      const plan = goal?.studyPlan ?? null;
      const material = await loadMaterial(scope, courseId);
      const { progress } = await progressFor(scope, courseId, material, timeZone);
      const pendingLessons = new Set((await plans.listPlanTasks(scope, courseId))
        .filter((task) => task.status === "pending" && task.slot.kind === "lesson")
        .flatMap((task) => task.slot.lessonIndexes));
      const projection = plan
        ? projectStudyPlan({ today, startDate: plan.startDate, lessonsPerDay: plan.lessonsPerDay, targetDate: goal?.targetDate ?? null, lessons: progress, scheduledToday: [...pendingLessons] })
        : null;
      const lessons: CourseStudyPlanLesson[] = material.lessons.map((lesson) => {
        const taughtOn = progress[lesson.index]!.taughtOn;
        const planned = projection?.lessons[lesson.index]?.date ?? null;
        const { from, to } = pageRange(lesson.pages);
        const status: CourseStudyPlanLesson["status"] = taughtOn
          ? "taught"
          : pendingLessons.has(lesson.index) || planned === today
            ? "today"
            : planned ? "planned" : "unscheduled";
        return { number: lesson.index + 1, title: lesson.title.slice(0, 240), pageFrom: from, pageTo: to, status, date: taughtOn ?? planned };
      });
      return {
        courseId,
        plan,
        targetDate: goal?.targetDate ?? null,
        lessons,
        reviewDates: (projection?.reviewDates ?? []).slice(0, 200),
        finishDate: projection?.finishDate ?? null,
        behind: projection?.behind ?? false,
        noMaterial: material.lessons.length === 0,
      };
    },

    /** Starts, changes or stops a course's plan; existing tasks stay as they are. */
    async save(scope: Scope, courseId: string, raw: unknown): Promise<void> {
      const input = courseStudyPlanInputSchema.parse(raw);
      const { prefs: current } = await prefs.get(scope);
      const previous = current.courseGoals[courseId];
      const weeklyMinutes = previous?.weeklyMinutes ?? 0;
      const keep = input.plan || input.targetDate || weeklyMinutes;
      await prefs.patch(scope, {
        courseGoal: {
          courseId,
          goal: keep ? { targetDate: input.targetDate, weeklyMinutes, ...(input.plan ? { studyPlan: input.plan } : {}) } : null,
        },
      });
    },
  };
}

export type OpeningStudyPlanService = ReturnType<typeof createOpeningStudyPlanService>;
