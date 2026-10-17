import { examErrorCauseSchema, examWorkReviewProposalSchema, type ExamSprintOverview, type ExamIntegrationOverview, type ExamForecastOverview, type ExamWorkReview } from "@aistudy/contracts";
import { z } from "zod";

const runSchema = z.object({
  id: z.string(), mode: z.enum(["diagnostic", "practice", "retest", "mock-a", "mock-b"]), questionIds: z.array(z.string()),
  startedAt: z.string(), deadlineAt: z.string().nullable(), completedAt: z.string().nullable(),
});
const attemptSchema = z.object({
  id: z.string(), questionId: z.string(), runId: z.string(), presentedAt: z.string(), answeredAt: z.string().nullable(),
  answer: z.string().nullable(), correct: z.boolean().nullable(), confidence: z.number().nullable(), durationSeconds: z.number().nullable(),
  help: z.array(z.object({ kind: z.enum(["hint", "solution", "external"]), at: z.string() })), errorCause: examErrorCauseSchema.nullable(),
  question: z.object({
    id: z.string(), topicId: z.string(), skillId: z.string(), familyId: z.string(), lessonId: z.string(),
    difficulty: z.enum(["foundation", "transfer"]), prompt: z.string(), options: z.array(z.object({ id: z.string(), label: z.string() })), estimatedMinutes: z.number(),
  }),
  prediction: z.object({ predictedAt: z.string(), skillId: z.string(), historyAttemptIds: z.array(z.string()), modelVersion: z.string().min(1).max(100), calibrated: z.literal(false), bktCorrect: z.number(), baselineCorrect: z.number() }).optional(),
  feedback: z.object({ answer: z.string(), explanation: z.string() }).nullable(), hint: z.string().nullable(), independent: z.boolean(),
});
// A malformed 2xx response cannot acknowledge a write: validate the HTTP boundary
// before discarding the command's idempotency key or presenting new progress.
export const overviewSchema: z.ZodType<ExamSprintOverview> = z.object({
  pack: z.object({
    id: z.string(), version: z.string(), title: z.string(), description: z.string(),
    topics: z.array(z.object({ id: z.string(), title: z.string() })),
    lessons: z.array(z.object({ id: z.string(), topicId: z.string(), title: z.string(), summary: z.string(), steps: z.array(z.string()), workedExample: z.string(), pitfalls: z.array(z.string()) })),
    sourceItems: z.array(z.object({ id: z.string(), topicId: z.string(), label: z.string(), sourceTitle: z.string(), sourcePage: z.number().nullable(), kind: z.enum(["choice", "problem", "exercise"]), suggestedDay: z.number(), skills: z.array(z.string()) })),
    weekPlan: z.array(z.object({ day: z.number(), minutes: z.number(), title: z.string(), tasks: z.array(z.string()) })), limitations: z.array(z.string()),
  }),
  state: z.object({
    version: z.literal(1), startedAt: z.string(), examDate: z.string().nullable(), dailyMinutes: z.number(), runs: z.array(runSchema),
    sourceRecords: z.array(z.object({
      id: z.string(), sourceId: z.string(), phase: z.enum(["first", "blind", "delayed", "variant"]), outcome: z.enum(["correct", "partial", "incorrect", "read"]),
      assistance: z.enum(["none", "hint", "solution"]), durationMinutes: z.number(), errorCause: examErrorCauseSchema.nullable(), note: z.string(), recordedAt: z.string(), answerText: z.string().optional(), workSourceId: z.string().optional(), workSourceVersion: z.number().optional(), reviewId: z.string().optional(), referenceChecked: z.boolean().optional(),
    })),
  }),
  attempts: z.array(attemptSchema), activeRun: runSchema.nullable(), currentAttempt: attemptSchema.nullable(),
  skills: z.array(z.object({ skillId: z.string(), topicId: z.string(), title: z.string(), status: z.enum(["untested", "weak", "usable", "secure"]), independentCorrect: z.number(), attempted: z.number(), dueAt: z.string().nullable(), reason: z.string(), lessonId: z.string() })),
  summary: z.object({ sourceTotal: z.number(), sourceCovered: z.number(), sourceIndependent: z.number(), sourceDelayed: z.number(), onlineAnswered: z.number(), onlineIndependentCorrect: z.number() }),
  recommendations: z.array(z.object({ title: z.string(), reason: z.string(), lessonId: z.string().nullable(), mode: z.enum(["practice", "retest"]) })),
  workload: z.object({ remainingItems: z.number(), estimatedMinutes: z.number().nullable(), availableMinutes: z.number().nullable(), overloaded: z.boolean(), message: z.string() }),
});

export const integrationSchema: z.ZodType<ExamIntegrationOverview> = z.object({
  binding: z.object({ courseId: z.string(), milestoneId: z.string().nullable(), packSourceId: z.string(), boundAt: z.string(), skills: z.array(z.object({ skillId: z.string(), nodeId: z.string(), requirementKey: z.string() })), materials: z.array(z.object({ sourceTitle: z.string(), sourceId: z.string(), sourceVersion: z.number() })) }).nullable(),
  links: z.array(z.object({ examAttemptId: z.string(), learningAttemptId: z.string(), observationId: z.string().nullable(), nodeId: z.string(), requirementKey: z.string(), publication: z.enum(["pending_mock", "published", "pending_answer", "unavailable"]) })),
  bkt: z.object({ calibrated: z.literal(false), eligible: z.number(), excluded: z.number(), bktBrier: z.number().nullable(), baselineBrier: z.number().nullable(), skills: z.array(z.object({ skillId: z.string(), eligible: z.number(), nextCorrectProbability: z.number().nullable() })), message: z.string() }),
  courseGoal: z.object({ targetDate: z.string().nullable(), weeklyMinutes: z.number().nullable(), milestoneTitle: z.string().nullable() }).nullable(),
  sourceMappings: z.array(z.object({ sourceItemId: z.string(), skillIds: z.array(z.string()), nodeIds: z.array(z.string()), sourceId: z.string().nullable(), sourceVersion: z.number().nullable(), physicalPage: z.number().nullable() })),
});

export const forecastSchema: z.ZodType<ExamForecastOverview> = z.object({
  teacher: z.string().nullable(),
  papers: z.array(z.object({ id: z.string(), courseId: z.string(), recordedAt: z.string(), sourceId: z.string(), sourceVersion: z.number(), teacher: z.string(), year: z.number(), label: z.string(), kind: z.enum(["past_exam", "sample", "exercise"]), skills: z.array(z.object({ skillId: z.string(), points: z.number() })) })),
  topics: z.array(z.object({ skillId: z.string(), examinedPapers: z.number(), totalPapers: z.number(), probability: z.number().nullable(), lower: z.number().nullable(), upper: z.number().nullable(), meanPoints: z.number().nullable() })),
  status: z.enum(["no_history", "limited_history", "history_based"]), message: z.string(),
});

export const reviewSchema: z.ZodType<ExamWorkReview> = z.object({ id: z.string(), sourceItemId: z.string(), workSourceId: z.string(), workSourceVersion: z.number(), referenceSourceId: z.string(), referenceSourceVersion: z.number(), answerText: z.string(), createdAt: z.string(), status: z.enum(["pending", "ready", "unknown", "failed"]), proposal: examWorkReviewProposalSchema.nullable(), modelLabel: z.string().nullable() });
