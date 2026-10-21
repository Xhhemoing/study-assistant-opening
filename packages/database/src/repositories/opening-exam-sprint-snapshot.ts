import { z } from "zod";
import { examErrorCauseSchema, type ExamPack, type ExamSprintState } from "@aistudy/contracts";
import { validExamLessonExposure } from "@aistudy/domain";

const id = z.string().min(1);
const timestamp = z.string().datetime({ offset: true });
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});
const mode = z.enum(["diagnostic", "practice", "retest", "mock-a", "mock-b"]);
const exposureMappingSchema = z.object({ contentFingerprint: id, mappingVersion: id,
  displayedFamilyIds: z.array(id).refine(ids => new Set(ids).size === ids.length),
  partialFamilyIds: z.array(id).refine(ids => new Set(ids).size === ids.length).optional() }).strict();
const questionSchema = z.object({
  id, topicId: id, skillId: id, familyId: id, lessonId: id,
  pool: z.enum(["training", "mock-a", "mock-b"]), difficulty: z.enum(["foundation", "transfer"]),
  prompt: z.string(), options: z.array(z.object({ id, label: z.string() }).strict()).min(2),
  answer: id, explanation: z.string(), hint: z.string(), estimatedMinutes: z.number().positive(),
}).strict().refine(question => question.options.some(option => option.id === question.answer)
  && new Set(question.options.map(option => option.id)).size === question.options.length);
const packSchema: z.ZodType<ExamPack> = z.object({
  id, version: id, title: z.string(), description: z.string(),
  topics: z.array(z.object({ id, title: z.string() }).strict()).min(1),
  lessons: z.array(z.object({ id, topicId: id, title: z.string(), summary: z.string(),
    steps: z.array(z.string()), workedExample: z.string(), pitfalls: z.array(z.string()),
    exposure: exposureMappingSchema.optional() }).strict()),
  questions: z.array(questionSchema).min(1),
  sourceItems: z.array(z.object({ id, topicId: id, label: z.string(), sourceTitle: z.string(),
    sourcePage: z.number().int().positive().nullable(), kind: z.enum(["choice", "problem", "exercise"]),
    suggestedDay: z.number().int().positive(), skills: z.array(id) }).strict()),
  weekPlan: z.array(z.object({ day: z.number().int().positive(), minutes: z.number().nonnegative(),
    title: z.string(), tasks: z.array(z.string()) }).strict()), limitations: z.array(z.string()),
}).strict();
const stateSchema: z.ZodType<ExamSprintState> = z.object({
  version: z.literal(1), startedAt: timestamp, examDate: date.nullable(), dailyMinutes: z.number().int().min(15).max(720),
  runs: z.array(z.object({ id, mode, questionIds: z.array(id), startedAt: timestamp,
    deadlineAt: timestamp.nullable(), completedAt: timestamp.nullable() }).strict()),
  attempts: z.array(z.object({ id, questionId: id, runId: id, presentedAt: timestamp,
    answeredAt: timestamp.nullable(), answer: z.string().nullable(), correct: z.boolean().nullable(),
    confidence: z.number().int().min(1).max(5).nullable(), durationSeconds: z.number().nonnegative().nullable(),
    help: z.array(z.object({ kind: z.enum(["hint", "solution", "external"]), at: timestamp }).strict()),
    lessonExposureIds: z.array(id).optional(), seenExampleExposureIds: z.array(id).optional(),
    partialExampleExposureIds: z.array(id).optional(), firstFamilyExposure: z.boolean().nullable().optional(),
    exposureCoverage: z.object({ kind: z.enum(["legacy_untracked_source", "unverifiable_source"]),
      packSourceId: z.string().uuid(), sourceVersion: z.number().int().nonnegative() }).strict().optional(),
    prediction: z.object({ predictedAt: timestamp, skillId: id, historyAttemptIds: z.array(id),
      modelVersion: z.string().min(1).max(100), calibrated: z.literal(false),
      bktCorrect: z.number().min(0).max(1), baselineCorrect: z.number().min(0).max(1) }).strict().optional(),
    errorCause: examErrorCauseSchema.nullable() }).strict()),
  sourceRecords: z.array(z.object({ id, sourceId: id, phase: z.enum(["first", "blind", "delayed", "variant"]),
    outcome: z.enum(["correct", "partial", "incorrect", "read"]), assistance: z.enum(["none", "hint", "solution"]),
    durationMinutes: z.number().min(0).max(720), errorCause: examErrorCauseSchema.nullable(),
    note: z.string().max(2000), recordedAt: timestamp, answerText: z.string().max(20000).optional(),
    workSourceId: z.string().uuid().optional(), workSourceVersion: z.number().int().nonnegative().optional(),
    reviewId: z.string().uuid().optional(), referenceChecked: z.boolean().optional() }).strict()),
  lessonExposures: z.array(exposureMappingSchema.extend({ id, clientKey: id, openedAt: timestamp,
    runId: id.nullable(), lessonId: id, packId: id, packVersion: id }).strict()).default([]),
}).strict();

export class OpeningExamSprintRepositoryError extends Error {
  constructor(readonly code: "NOT_FOUND" | "CONFLICT", message: string) {
    super(message);
    this.name = "OpeningExamSprintRepositoryError";
  }
}

export function corrupt(): never {
  throw new OpeningExamSprintRepositoryError("CONFLICT", "冲刺记录或题包无法校验，请保留数据并联系维护者");
}
function unique(items: Array<{ id: string }>): boolean {
  return new Set(items.map(item => item.id)).size === items.length;
}
export function parseExamSprintSnapshot(rawPack: unknown, rawState: unknown): { pack: ExamPack; state: ExamSprintState } {
  const parsedPack = packSchema.safeParse(rawPack), parsedState = stateSchema.safeParse(rawState);
  if (!parsedPack.success || !parsedState.success) return corrupt();
  const pack = parsedPack.data, state = parsedState.data;
  if (![pack.topics, pack.lessons, pack.questions, pack.sourceItems, state.runs, state.attempts, state.sourceRecords, state.lessonExposures!].every(unique)) return corrupt();
  const topics = new Set(pack.topics.map(topic => topic.id));
  const lessons = new Map(pack.lessons.map(lesson => [lesson.id, lesson]));
  const questions = new Map(pack.questions.map(question => [question.id, question]));
  const runs = new Map(state.runs.map(run => [run.id, run]));
  const sources = new Set(pack.sourceItems.map(source => source.id));
  const exposures = new Map(state.lessonExposures!.map(exposure => [exposure.id, exposure]));
  if (pack.lessons.some(lesson => !topics.has(lesson.topicId))
    || pack.questions.some(question => !topics.has(question.topicId) || lessons.get(question.lessonId)?.topicId !== question.topicId)
    || pack.sourceItems.some(source => !topics.has(source.topicId))
    || state.runs.filter(run => run.completedAt === null).length > 1
    || new Set(state.lessonExposures!.map(exposure => exposure.clientKey)).size !== state.lessonExposures!.length
    || new Set(state.lessonExposures!.map(exposure => JSON.stringify([exposure.runId, exposure.lessonId,
      exposure.packId, exposure.packVersion, exposure.contentFingerprint, exposure.mappingVersion]))).size !== state.lessonExposures!.length
    || state.lessonExposures!.some(exposure => {
      const lesson = lessons.get(exposure.lessonId), mapping = lesson ? validExamLessonExposure(lesson) : null;
      const run = exposure.runId === null ? null : runs.get(exposure.runId);
      return !mapping || exposure.packId !== pack.id || exposure.packVersion !== pack.version
        || exposure.contentFingerprint !== mapping.contentFingerprint || exposure.mappingVersion !== mapping.mappingVersion
        || exposure.displayedFamilyIds.length !== mapping.displayedFamilyIds.length
        || exposure.displayedFamilyIds.some(familyId => !mapping.displayedFamilyIds.includes(familyId))
        || (exposure.partialFamilyIds ?? []).length !== (mapping.partialFamilyIds ?? []).length
        || (exposure.partialFamilyIds ?? []).some(familyId => !mapping.partialFamilyIds?.includes(familyId))
        || exposure.runId !== null && (!run || Date.parse(exposure.openedAt) < Date.parse(run.startedAt)
          || run.completedAt !== null && Date.parse(exposure.openedAt) > Date.parse(run.completedAt)
          || (run.mode === "mock-a" || run.mode === "mock-b") && (run.completedAt === null || Date.parse(exposure.openedAt) < Date.parse(run.completedAt)));
    })
    || state.runs.some(run => new Set(run.questionIds).size !== run.questionIds.length
      || run.questionIds.some(questionId => !questions.has(questionId))
      || (run.completedAt !== null && Date.parse(run.completedAt) < Date.parse(run.startedAt)))
    || state.attempts.some(attempt => {
      const question = questions.get(attempt.questionId), run = runs.get(attempt.runId);
      if (!question || !run?.questionIds.includes(attempt.questionId)
        || Date.parse(attempt.presentedAt) < Date.parse(run.startedAt)) return true;
      const cutoff = Date.parse(attempt.answeredAt ?? "9999-12-31T23:59:59.999Z");
      if ([attempt.lessonExposureIds ?? [], attempt.seenExampleExposureIds ?? [], attempt.partialExampleExposureIds ?? []].some(ids => new Set(ids).size !== ids.length)
        || (attempt.lessonExposureIds ?? []).some(id => {
          const exposure = exposures.get(id);
          return !exposure || exposure.lessonId !== question.lessonId || exposure.runId !== attempt.runId
            || Date.parse(exposure.openedAt) > cutoff;
        }) || (attempt.seenExampleExposureIds ?? []).some(id => {
          const exposure = exposures.get(id);
          return !exposure || !exposure.displayedFamilyIds.includes(question.familyId) || Date.parse(exposure.openedAt) > cutoff;
        }) || (attempt.partialExampleExposureIds ?? []).some(id => {
          const exposure = exposures.get(id);
          return !exposure || !exposure.partialFamilyIds?.includes(question.familyId) || Date.parse(exposure.openedAt) > cutoff;
        })) return true;
      if (attempt.answeredAt === null) {
        return attempt.answer !== null || attempt.correct !== null || attempt.confidence !== null || attempt.durationSeconds !== null;
      }
      return !question.options.some(option => option.id === attempt.answer)
        || attempt.correct !== (attempt.answer === question.answer) || attempt.confidence === null || attempt.durationSeconds === null
        || Date.parse(attempt.answeredAt) < Date.parse(attempt.presentedAt);
    })
    || new Set(state.attempts.map(attempt => `${attempt.runId}:${attempt.questionId}`)).size !== state.attempts.length
    || state.sourceRecords.some(record => !sources.has(record.sourceId))) return corrupt();
  return { pack, state };
}
