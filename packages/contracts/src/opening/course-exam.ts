import { z } from "zod";

export const courseExamInputSchema = z.object({
  clientKey: z.string().min(8).max(100), sourceId: z.string().uuid(),
  questionCount: z.number().int().min(3).max(10).default(5),
  firstPage: z.number().int().positive().optional(), lastPage: z.number().int().positive().optional(),
}).strict().refine(value => value.lastPage === undefined || value.firstPage !== undefined && value.lastPage >= value.firstPage,
  "页码范围无效");
export type CourseExamInput = z.infer<typeof courseExamInputSchema>;

/** Model output is a proposal based on the selected paper, never an official answer key. */
export const courseExamProposalSchema = z.object({
  title: z.string().trim().min(1).max(200),
  topics: z.array(z.object({ label: z.string().trim().min(1).max(120), evidenceChunkIds: z.array(z.string().uuid()).min(1).max(8) }).strict()).min(1).max(20),
  questions: z.array(z.object({
    topic: z.string().trim().min(1).max(120), prompt: z.string().trim().min(10).max(8000),
    referenceAnswer: z.string().trim().min(1).max(10000), rubric: z.array(z.string().trim().min(1).max(1000)).min(1).max(10),
    hints: z.object({ direction: z.string().trim().min(1).max(1000), concept: z.string().trim().min(1).max(1000), firstStep: z.string().trim().min(1).max(1000) }).strict(),
    evidenceChunkIds: z.array(z.string().uuid()).min(1).max(8), estimatedMinutes: z.number().int().min(1).max(60),
  }).strict()).min(3).max(10),
}).strict();
export type CourseExamProposal = z.infer<typeof courseExamProposalSchema>;

/** Private persistence shape. HTTP responses use the redacted overview below. */
const courseExamSavedRequestSchema = z.object({
  id: z.string().uuid(), input: courseExamInputSchema, sourceVersion: z.number().int().nonnegative(), sourceTitle: z.string(),
  privacyEpoch: z.number().int().nonnegative(), createdAt: z.string().datetime(),
  status: z.enum(["pending", "ready", "failed", "unknown"]), proposal: courseExamProposalSchema.nullable(),
  activityId: z.string().uuid().nullable(), modelLabel: z.string().nullable(),
}).strict().refine(request => request.status === "ready" ? request.proposal !== null && request.activityId !== null
  : request.proposal === null && request.activityId === null, "invalid paper publication state");
export const courseExamSnapshotSchema = z.object({ format: z.literal("course-exam-v1"), requests: z.array(courseExamSavedRequestSchema) }).strict();
export type CourseExamSnapshot = z.infer<typeof courseExamSnapshotSchema>;

export const courseExamOverviewSchema = z.object({
  courseId: z.string().uuid(), courseTitle: z.string(), targetDate: z.string().nullable(), dailyMinutes: z.number().nullable(),
  sources: z.array(z.object({ id: z.string().uuid(), title: z.string(), version: z.number().int().nonnegative() }).strict()),
  papers: z.array(z.object({ id: z.string().uuid(), clientKey: z.string(), sourceTitle: z.string(), createdAt: z.string().datetime(),
    status: z.enum(["pending", "ready", "failed", "unknown"]), title: z.string().nullable(), topics: z.array(z.string()),
    questionCount: z.number().int().positive(), activityId: z.string().uuid().nullable(), available: z.boolean(),
  }).strict()),
}).strict();
export type CourseExamOverview = z.infer<typeof courseExamOverviewSchema>;
