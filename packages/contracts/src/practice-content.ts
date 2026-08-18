import { z } from "zod";
import { abilitySliceSchema, practiceItemKindSchema } from "./attempts";

const nonemptyToken = z.string().trim().min(1);

export const answerRuleSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("exact"),
    accepted: z.array(nonemptyToken).min(1),
  }),
  z.object({
    type: z.literal("token_set"),
    accepted: z.array(z.array(nonemptyToken).min(1)).min(1),
  }),
]);

export const publicPracticeItemSchema = z
  .object({
    id: z.string().uuid(),
    contentVersion: z.number().int().positive(),
    syllabusPointId: z.string().uuid(),
    kind: practiceItemKindSchema,
    stem: z.string().min(1),
    options: z.array(z.string().min(1)).optional(),
    abilitySlice: abilitySliceSchema,
    estimatedMinutes: z.number().int().positive(),
    availableHintCount: z.number().int().nonnegative(),
  })
  .strict();

export const startPracticeRequestSchema = z
  .object({
    practiceItemId: z.string().uuid(),
  })
  .strict();

export const startPracticeResponseSchema = z
  .object({
    sessionId: z.string().uuid(),
    item: publicPracticeItemSchema,
  })
  .strict();

export const requestHintResponseSchema = z.object({
  hintIndex: z.number().int().nonnegative(),
  hint: z.string().min(1),
});

export const revealAnswerResponseSchema = z.object({
  answer: z.string().min(1),
});

export const practiceSessionRecordSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  ownerUserId: z.string().uuid(),
  practiceItemId: z.string().uuid(),
  contentVersion: z.number().int().positive(),
  startedAt: z.string().datetime(),
  hintCount: z.number().int().nonnegative(),
  answerRevealedAt: z.string().datetime().nullable(),
  submittedAt: z.string().datetime().nullable(),
});

export const gradablePracticeItemSchema = publicPracticeItemSchema.extend({
  answerRule: answerRuleSchema,
  answerDisplay: z.string().min(1),
  hints: z.array(z.string().min(1)),
});

export const syllabusPointRecordSchema = z.object({
  id: z.string().uuid(),
  packageId: z.string().uuid(),
  parentId: z.string().uuid().nullable(),
  code: z.string().min(1),
  title: z.string().min(1),
  sortOrder: z.number().int(),
});

export const practiceCandidateRecordSchema = z.object({
  id: z.string().uuid(),
  contentVersion: z.number().int().positive(),
  syllabusPointId: z.string().uuid(),
  kind: practiceItemKindSchema,
  abilitySlice: abilitySliceSchema,
  estimatedMinutes: z.number().int().positive(),
});

export type AnswerRule = z.infer<typeof answerRuleSchema>;
export type PublicPracticeItem = z.infer<typeof publicPracticeItemSchema>;
export type StartPracticeRequest = z.infer<typeof startPracticeRequestSchema>;
export type StartPracticeResponse = z.infer<typeof startPracticeResponseSchema>;
export type RequestHintResponse = z.infer<typeof requestHintResponseSchema>;
export type RevealAnswerResponse = z.infer<typeof revealAnswerResponseSchema>;
export type PracticeSessionRecord = z.infer<typeof practiceSessionRecordSchema>;
export type GradablePracticeItem = z.infer<typeof gradablePracticeItemSchema>;
export type SyllabusPointRecord = z.infer<typeof syllabusPointRecordSchema>;
export type PracticeCandidateRecord = z.infer<typeof practiceCandidateRecordSchema>;
