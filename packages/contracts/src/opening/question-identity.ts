import { z } from "zod";
import { uuidSchema } from "./foundation";
import { courseRequirementSourceRefSchema } from "./course-route";
import { problemRefSchema } from "./learning";
import { activitySpecSchema, teachingBlockRefSchema, teachingBlockRoleSchema, teachingSourceRefSchema } from "./teaching-content";

export const QUESTION_IDENTITY_PROTOCOL = "question-identity-1" as const;

/** The existing teaching source shape, narrowed to a known immutable source version. */
export const questionSourceRefSchema = teachingSourceRefSchema.extend({
  version: courseRequirementSourceRefSchema.shape.sourceVersion,
}).strict();

/** References only: resolve exact conditions/figures privately, never send answer text here. */
export const questionContentRefSchema = z.discriminatedUnion("kind", [
  questionSourceRefSchema.extend({ kind: z.literal("source") }).strict(),
  activitySpecSchema.pick({ documentId: true, revisionNumber: true }).extend({
    kind: z.literal("block"),
    blockId: teachingBlockRefSchema.shape.blockId,
  }).strict(),
]);

/** Existing source problem, teaching publication and exam catalog identities, not a new catalog. */
export const questionRefSchema = z.discriminatedUnion("kind", [
  problemRefSchema.pick({ problemId: true, sourceId: true, sourceVersion: true }).extend({
    kind: z.literal("source_problem"),
  }).strict(),
  activitySpecSchema.pick({ activityId: true, documentId: true, revisionNumber: true }).extend({
    kind: z.literal("teaching_question"),
    contentVersion: activitySpecSchema.shape.version,
    questionBlockId: teachingBlockRefSchema.shape.blockId,
    answerBlockId: teachingBlockRefSchema.shape.blockId,
  }).strict(),
  z.object({
    kind: z.literal("exam_question"),
    // ExamPack/ExamQuestion IDs and versions are strings, NOT UUIDs.
    packId: z.string().min(1).max(100),
    packVersion: z.string().min(1).max(100),
    questionId: z.string().min(1).max(100),
    familyId: z.string().min(1).max(100),
  }).strict(),
]);

/**
 * PRIVATE server registry descriptor. Parsing validates shape, NOT authorization or truth.
 * Only a server that resolves immutable refs, exact conditions, every figure and the
 * answer role may assign this identity. Client hashes/semantic similarity cannot do so.
 * Empty figureRefs means server-confirmed absence of figures, never missing extraction.
 */
export const questionIdentitySchema = z.object({
  protocolVersion: z.literal(QUESTION_IDENTITY_PROTOCOL),
  identityRefId: uuidSchema,
  questionRef: questionRefSchema,
  sourceRefs: z.array(questionSourceRefSchema).min(1).max(32),
  conditionRefs: z.array(questionContentRefSchema).min(1).max(64),
  figureRefs: z.array(questionContentRefSchema).max(32),
  answerRole: teachingBlockRoleSchema.extract(["answer_key"]),
}).strict().superRefine((value, ctx) => {
  const ref = value.questionRef;
  if (ref.kind === "teaching_question" && ref.questionBlockId === ref.answerBlockId) {
    ctx.addIssue({ code: "custom", path: ["questionRef", "answerBlockId"], message: "Question and answer blocks must differ" });
  }
  if (ref.kind === "source_problem" && !value.sourceRefs.some(source =>
    source.sourceId === ref.sourceId && source.version === ref.sourceVersion)) {
    ctx.addIssue({ code: "custom", path: ["sourceRefs"], message: "Question source version must be pinned" });
  }
});

const serverExactReceiptSchema = z.object({
  receiptId: uuidSchema,
  method: z.literal("server_exact"),
  comparatorVersion: z.string().min(1).max(100),
  conditions: z.literal("exact"),
  figures: z.literal("exact"),
  answerRole: z.literal("exact"),
}).strict();

/**
 * PRIVATE comparison result. Only same/equivalent_exact can support exact deduplication.
 * Semantic/model similarity is candidate only. Unknown/conflict neither deduplicate nor
 * establish unseen status. Receipts must be resolved and bound to BOTH refs by the server;
 * parsing this shape alone (including a client-supplied receipt UUID) grants no trust.
 */
export const questionIdentityMatchSchema = z.object({
  protocolVersion: z.literal(QUESTION_IDENTITY_PROTOCOL),
  leftIdentityRefId: uuidSchema,
  rightIdentityRefId: uuidSchema,
  result: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("same"), receipt: serverExactReceiptSchema }).strict(),
    z.object({ kind: z.literal("equivalent_exact"), receipt: serverExactReceiptSchema }).strict(),
    z.object({ kind: z.literal("candidate"), basis: z.enum(["semantic", "model", "unverified_reference"]) }).strict(),
    z.object({ kind: z.literal("unknown"), reason: z.enum(["missing_identity", "missing_conditions", "missing_figures", "unavailable_reference"]) }).strict(),
    z.object({ kind: z.literal("conflict"), dimensions: z.array(z.enum(["source_version", "conditions", "figures", "answer_role"])).min(1).max(4) }).strict(),
  ]),
}).strict();

/**
 * PRIVATE answer-key binding: no raw answers or browser projection. A match, a model's
 * answer or reference-check `matched` is NOT key verification. The service must resolve
 * this immutable keyRefId against this exact identity/source version and either a
 * deterministic evaluator or an independently verified family receipt. Never authorize
 * a key merely because client data parses, nor extend match evidence into stronger truth.
 */
export const privateTrustedQuestionKeySchema = z.object({
  keyRefId: uuidSchema,
  identity: questionIdentitySchema,
  verification: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("deterministic_evaluator"), receiptId: uuidSchema,
      evaluatorId: z.string().min(1).max(100), evaluatorVersion: z.string().min(1).max(100),
    }).strict(),
    z.object({
      kind: z.literal("independent_family"), receiptId: uuidSchema,
      familyId: z.string().min(1).max(100),
      verifierId: z.string().min(1).max(100), verifierVersion: z.string().min(1).max(100),
    }).strict(),
  ]),
}).strict().superRefine((value, ctx) => {
  const question = value.identity.questionRef;
  if (question.kind === "exam_question" && value.verification.kind === "independent_family"
    && question.familyId !== value.verification.familyId) {
    ctx.addIssue({ code: "custom", path: ["verification", "familyId"], message: "Verification must bind the question family" });
  }
});

export type QuestionSourceRef = z.infer<typeof questionSourceRefSchema>;
export type QuestionContentRef = z.infer<typeof questionContentRefSchema>;
export type QuestionRef = z.infer<typeof questionRefSchema>;
export type QuestionIdentity = z.infer<typeof questionIdentitySchema>;
export type QuestionIdentityMatch = z.infer<typeof questionIdentityMatchSchema>;
export type PrivateTrustedQuestionKey = z.infer<typeof privateTrustedQuestionKeySchema>;
