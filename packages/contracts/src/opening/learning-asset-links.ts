import { z } from "zod";
import { isoDateTimeSchema, uuidSchema } from "./foundation";
import { studyContextAnchorSchema } from "./tutor";
export const learningAssetPurposeSchema = z.enum(["reference", "understanding", "error_reason", "exploration"]);
const selection = { courseId: uuidSchema.nullable(), goalId: uuidSchema.nullable(), requirementId: uuidSchema.nullable(), expectedGoalRevision: z.number().int().positive().optional(), expectedRequirementRevision: z.number().int().positive().optional(), origin: studyContextAnchorSchema.nullable(), purpose: learningAssetPurposeSchema };
function targetIssues(value: { courseId: string | null; goalId: string | null; requirementId: string | null; expectedGoalRevision?: number; expectedRequirementRevision?: number }, ctx: z.RefinementCtx) {
  if ((value.goalId || value.requirementId) && !value.courseId) ctx.addIssue({ code: "custom", message: "目标与要求需要明确课程" });
  if ((value.goalId !== null) !== (value.expectedGoalRevision !== undefined)) ctx.addIssue({ code: "custom", message: "目标关联需要当前版本" });
  if ((value.requirementId !== null) !== (value.expectedRequirementRevision !== undefined)) ctx.addIssue({ code: "custom", message: "要求关联需要当前版本" });
}
export const learningAssetIdentitySchema = z.object({ assetType: z.enum(["source", "document"]), assetId: uuidSchema }).strict();
export const learningAssetLinkCreateSchema = learningAssetIdentitySchema.extend({ ...selection, assetVersion: z.number().int().nonnegative().nullable(), clientKey: z.string().min(8).max(200) }).strict().superRefine((value, ctx) => {
  targetIssues(value, ctx);
  if (value.assetType === "document" && value.assetVersion !== null) ctx.addIssue({ code: "custom", message: "笔记使用自身修订，不接受材料版本" });
});
export const studyNoteCreateSchema = z.object({ ...selection, clientKey: z.string().min(8).max(200), title: z.string().trim().min(1).max(200), text: z.string().trim().min(1).max(20000) }).strict().superRefine(targetIssues);
export const learningAssetLinkDetachSchema = z.object({ id: uuidSchema, expectedRevision: z.number().int().positive() }).strict();
export const learningAssetLinkSchema = z.object({ id: uuidSchema, ...learningAssetIdentitySchema.shape, assetVersion: z.number().int().nonnegative().nullable(), courseId: uuidSchema.nullable(), goalId: uuidSchema.nullable(), requirementId: uuidSchema.nullable(), purpose: learningAssetPurposeSchema, origin: studyContextAnchorSchema.nullable(), sourceRefs: z.array(z.object({ sourceId: uuidSchema, sourceVersion: z.number().int().nonnegative() }).strict()), status: z.enum(["active", "detached"]), revision: z.number().int().positive(), createdAt: isoDateTimeSchema, updatedAt: isoDateTimeSchema }).strict();
export const learningAssetLinkViewSchema = z.object({ link: learningAssetLinkSchema, courseTitle: z.string().nullable(), goalTitle: z.string().nullable(), requirementTitle: z.string().nullable(), assetAvailable: z.boolean(), originAvailable: z.boolean(), originHref: z.string().nullable(), sourceHrefs: z.array(z.object({ label: z.string(), href: z.string() }).strict()), warnings: z.array(z.string()) }).strict();
export const learningAssetLinkListSchema = z.object({ links: z.array(learningAssetLinkViewSchema) }).strict();
export const studyNoteCreateResultSchema = z.object({ documentId: uuidSchema, link: learningAssetLinkViewSchema }).strict();
export type LearningAssetLinkCreate = z.infer<typeof learningAssetLinkCreateSchema>;
export type LearningAssetLink = z.infer<typeof learningAssetLinkSchema>;
export type LearningAssetLinkView = z.infer<typeof learningAssetLinkViewSchema>;
export type LearningAssetLinkList = z.infer<typeof learningAssetLinkListSchema>;
export type StudyNoteCreate = z.infer<typeof studyNoteCreateSchema>;
