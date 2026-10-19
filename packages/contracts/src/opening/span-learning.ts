import { z } from "zod";
import { uuidSchema } from "./foundation";

export const spanExerciseInputSchema = z.object({
  sourceId: uuidSchema, problemId: z.string().min(1).max(100), version: z.number().int().positive(),
}).strict();
export type SpanExerciseInput = z.infer<typeof spanExerciseInputSchema>;
const rationalStringSchema = z.string().min(1).max(160);
const vectorSchema = z.array(rationalStringSchema).min(1).max(8);
export const spanProblemSchema = z.object({
  id: z.string().min(1).max(100), version: z.string().min(1).max(30), familyId: z.string().min(1).max(100),
  vectors: z.tuple([vectorSchema, vectorSchema]), target: vectorSchema,
  knowledgeComponents: z.array(z.string().min(1)).min(1),
  transfer: z.object({ fromFamilyId: z.string().min(1), changes: z.array(z.string().min(1)).min(1) }).optional(),
}).strict().refine((problem) => problem.vectors.every((vector) => vector.length === problem.target.length), "Vector dimensions must agree");

/** Span answers use exact strings; no client supplied score or mastery is accepted. */
export type SpanProblem = {
  id: string;
  version: string;
  familyId: string;
  vectors: [string[], string[]];
  target: string[];
  knowledgeComponents: string[];
  transfer?: { fromFamilyId: string; changes: string[] };
};

export type SpanAnswer = {
  membership: "in_span" | "not_in_span";
  coefficients?: [string, string];
  /** Optional learner-produced vector equation, not model-assessed prose. */
  equation?: { vectors: [string[], string[]]; target: string[] };
  /** Learner's computed left-hand sides, in coordinate order. */
  coordinateChecks?: string[];
  /** Learner-selected structural claims; free-form explanations are not auto-graded. */
  representations?: { system?: "unique" | "infinite" | "none"; geometry?: "plane" | "line" | "point" };
  /** Left-nullspace certificate: yᵀv=yᵀw=0 while yᵀu≠0. */
  noSolutionWitness?: string[];
  /** Two zero-based coordinate equations used to derive the submitted coefficients. */
  coefficientDerivationCoordinates?: [number, number];
  recognition?: "confirmed" | "uncertain";
};

export type SpanSolution =
  | { kind: "unique"; coefficients: [string, string] }
  | { kind: "infinite"; particular: [string, string]; directions: [string, string][] }
  | { kind: "none" }
  | { kind: "unknown"; reason: string };

export type SpanSkillResult = "correct" | "incorrect" | "unobserved";
const spanSkillResultSchema = z.enum(["correct", "incorrect", "unobserved"]);
export const spanVerificationSkillsSchema = z.object({
  equation: spanSkillResultSchema, coefficients: spanSkillResultSchema, allCoordinates: spanSkillResultSchema,
  systemConsistency: spanSkillResultSchema.optional(), geometry: spanSkillResultSchema.optional(), noSolutionProof: spanSkillResultSchema.optional(),
}).strict();
export type SpanVerification = {
  outcome: "correct" | "incorrect" | "unknown";
  membershipOutcome: "correct" | "incorrect" | "unobserved";
  /** True only when all three core performances were actually observed. */
  coreEvidenceComplete: boolean;
  reason: string;
  solution: SpanSolution;
  skills: { equation: SpanSkillResult; coefficients: SpanSkillResult; allCoordinates: SpanSkillResult; systemConsistency?: SpanSkillResult; geometry?: SpanSkillResult; noSolutionProof?: SpanSkillResult };
  /** Zero-based indices; every coordinate is checked by the verifier. */
  failedCoordinates: number[];
  countsAsStudentError: boolean;
};

export type SpanTeachingMode = "self_study" | "overview" | "challenge";
export type StudySessionIntent = {
  purpose: "confused" | "self_study" | "overview" | "challenge" | "review" | "exam_sprint";
  timeBudgetMinutes: number;
  language: "zh" | "en" | "bilingual";
  pace: "slow" | "normal" | "fast";
  explanationStyle?: "full" | "key_steps";
  continuous: boolean;
  selfReportedFatigue: "unknown" | "low" | "high";
};
export type SpanTeachingMove = {
  id: string;
  mode: SpanTeachingMode;
  /** Six required parts: target, presentation, student task, help, observation, continuation. */
  targetKnowledgeComponents: string[];
  presentation: { kind: "worked_example" | "faded_example" | "independent_item" | "contrast" | "predict_then_explore"; instructions: string };
  studentAction: string;
  allowedHelp: "full_example" | "step_hint" | "language_only";
  expectedObservation: string;
  continuation: { onSuccess: "next_move" | "delayed_check"; onFailure: "diagnose"; stopWhen: string };
};
