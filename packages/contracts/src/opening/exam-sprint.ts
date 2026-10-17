import { z } from "zod";
import type { ExamPredictionSnapshot } from "./exam-integration";

export const examErrorCauseSchema = z.enum(["concept", "method", "calculation", "conditions", "modeling", "reading", "time"]);
export type ExamErrorCause = z.infer<typeof examErrorCauseSchema>;
export type ExamMode = "diagnostic" | "practice" | "retest" | "mock-a" | "mock-b";
export type ExamSourceItem = { id: string; topicId: string; label: string; sourceTitle: string; sourcePage: number | null; kind: "choice" | "problem" | "exercise"; suggestedDay: number; skills: string[] };
export type ExamLesson = { id: string; topicId: string; title: string; summary: string; steps: string[]; workedExample: string; pitfalls: string[] };
export type ExamQuestion = {
  id: string; topicId: string; skillId: string; familyId: string; lessonId: string;
  pool: "training" | "mock-a" | "mock-b"; difficulty: "foundation" | "transfer";
  prompt: string; options: Array<{ id: string; label: string }>;
  answer: string; explanation: string; hint: string; estimatedMinutes: number;
};
export type ExamPack = {
  id: string; version: string; title: string; description: string;
  topics: Array<{ id: string; title: string }>;
  lessons: ExamLesson[]; questions: ExamQuestion[]; sourceItems: ExamSourceItem[];
  weekPlan: Array<{ day: number; minutes: number; title: string; tasks: string[] }>;
  limitations: string[];
};
export type ExamAttempt = {
  id: string; questionId: string; runId: string; presentedAt: string;
  answeredAt: string | null; answer: string | null; correct: boolean | null;
  confidence: number | null; durationSeconds: number | null;
  help: Array<{ kind: "hint" | "solution" | "external"; at: string }>;
  errorCause: ExamErrorCause | null;
  prediction?: ExamPredictionSnapshot;
};
export type ExamRun = { id: string; mode: ExamMode; questionIds: string[]; startedAt: string; deadlineAt: string | null; completedAt: string | null };
export type ExamSourceRecord = {
  id: string; sourceId: string; phase: "first" | "blind" | "delayed" | "variant";
  outcome: "correct" | "partial" | "incorrect" | "read";
  assistance: "none" | "hint" | "solution";
  durationMinutes: number; errorCause: ExamErrorCause | null; note: string; recordedAt: string;
  answerText?: string; workSourceId?: string; workSourceVersion?: number; reviewId?: string; referenceChecked?: boolean;
};
export type ExamSprintState = {
  version: 1; startedAt: string; examDate: string | null; dailyMinutes: number;
  runs: ExamRun[]; attempts: ExamAttempt[]; sourceRecords: ExamSourceRecord[];
};
export type ExamAttemptView = ExamAttempt & {
  question: Omit<ExamQuestion, "answer" | "explanation" | "hint" | "pool">;
  feedback: { answer: string; explanation: string } | null; hint: string | null;
  independent: boolean;
};
export type ExamSkillSummary = { skillId: string; topicId: string; title: string; status: "untested" | "weak" | "usable" | "secure"; independentCorrect: number; attempted: number; dueAt: string | null; reason: string; lessonId: string };
export type ExamSprintOverview = {
  pack: Omit<ExamPack, "questions">; state: Omit<ExamSprintState, "attempts">;
  attempts: ExamAttemptView[]; activeRun: ExamRun | null; currentAttempt: ExamAttemptView | null;
  skills: ExamSkillSummary[];
  summary: { sourceTotal: number; sourceCovered: number; sourceIndependent: number; sourceDelayed: number; onlineAnswered: number; onlineIndependentCorrect: number };
  recommendations: Array<{ title: string; reason: string; lessonId: string | null; mode: "practice" | "retest" }>;
  workload: { remainingItems: number; estimatedMinutes: number | null; availableMinutes: number | null; overloaded: boolean; message: string };
};

const key = z.string().min(8).max(200);
const id = z.string().min(1).max(100);
export const examSprintCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("configure"), clientKey: key, examDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => { const date = new Date(`${value}T00:00:00Z`); return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value; }).nullable(), dailyMinutes: z.number().int().min(15).max(720) }).strict(),
  z.object({ action: z.literal("start"), clientKey: key, mode: z.enum(["diagnostic", "practice", "retest", "mock-a", "mock-b"]) }).strict(),
  z.object({ action: z.literal("answer"), clientKey: key, attemptId: id, answer: z.string().min(1).max(20), confidence: z.number().int().min(1).max(5) }).strict(),
  z.object({ action: z.literal("help"), clientKey: key, attemptId: id, kind: z.enum(["hint", "solution", "external"]) }).strict(),
  z.object({ action: z.literal("next"), clientKey: key, runId: id }).strict(),
  z.object({ action: z.literal("finish"), clientKey: key, runId: id }).strict(),
  z.object({ action: z.literal("error"), clientKey: key, attemptId: id, errorCause: examErrorCauseSchema.nullable() }).strict(),
  z.object({ action: z.literal("source"), clientKey: key, sourceId: id, phase: z.enum(["first", "blind", "delayed", "variant"]), outcome: z.enum(["correct", "partial", "incorrect", "read"]), assistance: z.enum(["none", "hint", "solution"]), durationMinutes: z.number().min(0).max(720), errorCause: examErrorCauseSchema.nullable(), note: z.string().trim().max(2000), answerText: z.string().max(20000).optional(), workSourceId: z.string().uuid().optional(), workSourceVersion: z.number().int().nonnegative().optional(), reviewId: z.string().uuid().optional(), referenceChecked: z.boolean().optional() }).strict(),
]);
export type ExamSprintCommand = z.infer<typeof examSprintCommandSchema>;
