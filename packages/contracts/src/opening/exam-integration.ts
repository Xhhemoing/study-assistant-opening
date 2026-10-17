import { z } from "zod";
import { uuidSchema } from "./foundation";

export type ExamPredictionSnapshot = {
  predictedAt: string; skillId: string; historyAttemptIds: string[];
  modelVersion: string; calibrated: false;
  bktCorrect: number; baselineCorrect: number;
};
export type ExamSkillBinding = { skillId: string; nodeId: string; requirementKey: string };
export type ExamMaterialBinding = { sourceTitle: string; sourceId: string; sourceVersion: number };
export type ExamCourseBinding = {
  courseId: string; milestoneId: string | null; packSourceId: string; boundAt: string;
  skills: ExamSkillBinding[]; materials: ExamMaterialBinding[];
};
export const examBindInputSchema = z.object({
  clientKey: z.string().min(8).max(200), courseId: uuidSchema,
  milestoneId: uuidSchema.nullable().default(null), expectedPackVersion: z.string().min(1).max(100),
  createKnowledgeNodes: z.boolean().default(true),
  skills: z.array(z.object({ skillId: z.string().min(1).max(100), nodeId: uuidSchema }).strict()).max(100).default([]),
  materials: z.array(z.object({ sourceTitle: z.string().min(1).max(300), sourceId: uuidSchema, sourceVersion: z.number().int().nonnegative() }).strict()).max(32).default([]),
}).strict();
export type ExamBindInput = z.infer<typeof examBindInputSchema>;
export type ExamCanonicalLink = {
  examAttemptId: string; learningAttemptId: string; observationId: string | null;
  nodeId: string; requirementKey: string; publication: "pending_mock" | "published" | "pending_answer";
};
export type ExamBktReport = {
  calibrated: false; eligible: number; excluded: number; bktBrier: number | null; baselineBrier: number | null;
  skills: Array<{ skillId: string; eligible: number; nextCorrectProbability: number | null }>;
  message: string;
};
export type ExamIntegrationOverview = {
  binding: ExamCourseBinding | null; links: ExamCanonicalLink[];
  bkt: ExamBktReport;
  courseGoal: { targetDate: string | null; weeklyMinutes: number | null; milestoneTitle: string | null } | null;
  sourceMappings: Array<{ sourceItemId: string; skillIds: string[]; nodeIds: string[]; sourceId: string | null; sourceVersion: number | null; physicalPage: number | null }>;
};
export type ExamPaperKind = "past_exam" | "sample" | "exercise";
export const examPaperInputSchema = z.object({
  clientKey: z.string().min(8).max(200), sourceId: uuidSchema, sourceVersion: z.number().int().nonnegative(),
  teacher: z.string().trim().min(1).max(100), year: z.number().int().min(1900).max(2200),
  label: z.string().trim().min(1).max(200), kind: z.enum(["past_exam", "sample", "exercise"]),
  skills: z.array(z.object({ skillId: z.string().min(1).max(100), points: z.number().finite().min(0).max(10000) }).strict()).min(1).max(100),
}).strict().refine(input => new Set(input.skills.map(item => item.skillId)).size === input.skills.length, "duplicate skill");
export type ExamPaperInput = z.infer<typeof examPaperInputSchema>;
export type ExamPaper = Omit<ExamPaperInput, "clientKey"> & { id: string; courseId: string; recordedAt: string };
export type ExamTopicForecast = {
  skillId: string; examinedPapers: number; totalPapers: number; probability: number | null;
  lower: number | null; upper: number | null; meanPoints: number | null;
};
export type ExamForecastOverview = {
  teacher: string | null; papers: ExamPaper[]; topics: ExamTopicForecast[];
  status: "no_history" | "limited_history" | "history_based"; message: string;
};
export const examSourceMappingInputSchema = z.object({
  clientKey: z.string().min(8).max(200), sourceItemId: z.string().min(1).max(100),
  skillIds: z.array(z.string().min(1).max(100)).min(1).max(10),
}).strict();
export type ExamSourceMappingInput = z.infer<typeof examSourceMappingInputSchema>;

export const examWorkReviewInputSchema = z.object({
  clientKey: z.string().min(8).max(100), sourceItemId: z.string().min(1).max(100),
  workSourceId: uuidSchema, workSourceVersion: z.number().int().nonnegative(),
  referenceSourceId: uuidSchema, referenceSourceVersion: z.number().int().nonnegative(),
  answerText: z.string().trim().max(20000).default(""),
}).strict();
export const examWorkReviewProposalSchema = z.object({
  transcription: z.string().max(20000), questionMatch: z.boolean(),
  outcome: z.enum(["correct", "incorrect", "partial", "unverified"]),
  steps: z.array(z.object({ label: z.string().min(1).max(300), verdict: z.enum(["correct", "incorrect", "unverified"]), feedback: z.string().max(2000) }).strict()).max(30),
  summary: z.string().min(1).max(6000),
  errorCause: z.enum(["concept", "method", "calculation", "conditions", "modeling", "reading", "time"]).nullable(),
}).strict();
export type ExamWorkReviewInput = z.infer<typeof examWorkReviewInputSchema>;
export type ExamWorkReviewProposal = z.infer<typeof examWorkReviewProposalSchema>;
export type ExamWorkReview = {
  id: string; sourceItemId: string; workSourceId: string; referenceSourceId: string;
  workSourceVersion: number; referenceSourceVersion: number; answerText: string;
  createdAt: string; status: "pending" | "ready" | "unknown" | "failed";
  proposal: ExamWorkReviewProposal | null; modelLabel: string | null;
};
