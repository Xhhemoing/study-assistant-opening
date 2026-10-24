import { z } from "zod";
import { uuidSchema, isoDateTimeSchema } from "./foundation";

export const materialRoleSchema = z.enum(["lecture", "exercise", "answer_key", "solution", "exam_spec", "mixed"]);
export const materialQuestionKeySchema = z.object({
  family: z.string().trim().min(1).max(100), number: z.string().trim().min(1).max(60),
  subquestion: z.string().trim().max(60).default(""),
}).strict();
export const materialQuestionSchema = materialQuestionKeySchema.extend({
  page: z.number().int().positive(), stem: z.string().trim().min(1).max(2000),
}).strict();
const materialAnswerLinkFields = z.object({
  page: z.number().int().positive(), questionSourceId: uuidSchema, questionSourceVersion: z.number().int().nonnegative(),
  question: materialQuestionKeySchema,
  text: z.string().trim().min(1).max(8000),
  status: z.enum(["trusted", "disputed", "unverified"]).default("unverified"),
  reason: z.string().trim().max(1000).default(""),
  /** Set by the repository on edits; an incoming claimed reviewer is never trusted. */
  reviewedBy: uuidSchema.optional(),
  reviewedAt: isoDateTimeSchema.optional(),
}).strict();
const hasReviewReason = (value: {status:string;reason:string}) => value.status === "unverified" || value.reason.length > 0;
export const materialAnswerLinkSchema = materialAnswerLinkFields.refine(hasReviewReason,"核验或争议须填写理由");
export const materialAnswerReadSchema = materialAnswerLinkFields.extend({
  sourceId:uuidSchema,sourceVersion:z.number().int().nonnegative(),
  reviewedBy:uuidSchema.nullable().optional(),reviewedAt:isoDateTimeSchema.nullable().optional(),
}).refine(hasReviewReason,"核验或争议须填写理由");
export const materialManifestSchema = z.object({
  role: materialRoleSchema,
  sections: z.array(z.object({ startPage: z.number().int().positive(), endPage: z.number().int().positive(),
    role: materialRoleSchema.exclude(["mixed"]),
  }).strict().refine(value => value.startPage <= value.endPage, "页段结束不能早于开始")).max(200).default([]),
  questions: z.array(materialQuestionSchema).max(1000).default([]),
  answers: z.array(materialAnswerLinkSchema).max(1000).default([]),
}).strict().superRefine((value, ctx) => {
  const sections = [...value.sections].sort((a,b) => a.startPage-b.startPage);
  for (let i=1;i<sections.length;i++) if (sections[i]!.startPage <= sections[i-1]!.endPage) ctx.addIssue({ code: "custom", message: "页段不可重叠", path: ["sections"] });
  if (value.role !== "mixed" && sections.length) ctx.addIssue({ code: "custom", message: "只有混合资料使用页段角色", path: ["sections"] });
  const keys = new Set<string>();
  for (const q of value.questions) {
    const key = JSON.stringify([q.family,q.number,q.subquestion]);
    if (keys.has(key)) ctx.addIssue({ code: "custom", message: "同练习族、原编号与子问只能登记一个正文题目", path: ["questions"] });
    keys.add(key);
    if (materialPageRole(value,q.page) !== "exercise") ctx.addIssue({ code: "custom", message: "题目只能登记在练习正文页段", path: ["questions"] });
  }
  for (const a of value.answers) if (!["answer_key","solution"].includes(materialPageRole(value,a.page))) {
    ctx.addIssue({ code: "custom", message: "答案关联必须位于答案或详解页段", path: ["answers"] });
  }
});
export type MaterialManifest = z.infer<typeof materialManifestSchema>;
export type MaterialQuestionKey = z.infer<typeof materialQuestionKeySchema>;
export function materialPageRole(manifest: { role: z.infer<typeof materialRoleSchema>; sections: Array<{ startPage: number; endPage: number; role: z.infer<typeof materialRoleSchema> }> }, page: number | null) {
  if (manifest.role !== "mixed") return manifest.role;
  return page == null ? "mixed" : manifest.sections.find(s => s.startPage <= page && s.endPage >= page)?.role ?? "mixed";
}
export const materialManifestWriteSchema = z.object({ sourceVersion: z.number().int().nonnegative(),
  expectedRevision: z.number().int().nonnegative(), manifest: materialManifestSchema,
  /** Metadata-only editors preserve hidden answers and replace supplied matching links. */
  mergeAnswerLinks: z.boolean().optional(),
}).strict();
export const materialQuestionIdentitySchema = materialQuestionKeySchema.extend({ sourceId: uuidSchema, sourceVersion: z.number().int().nonnegative() }).strict();
export type MaterialQuestionIdentity = z.infer<typeof materialQuestionIdentitySchema>;
