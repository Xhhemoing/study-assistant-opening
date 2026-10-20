import { z } from "zod";
import { uuidSchema } from "./foundation";

/** A labelled retrieval protocol, independent of predictions and student outcomes. */
export const materialRetrievalEvaluationSchema = z.object({
  protocolVersion: z.literal("study-material-retrieval-v1"),
  datasetId: z.string().min(1).max(120), corpusVersion: z.string().min(1).max(120),
  annotationProvenance: z.enum(["development_fixture", "human_labeled"]),
  scope: z.object({ workspaceId: uuidSchema, ownerUserId: uuidSchema }).strict(),
  k: z.number().int().min(1).max(10),
  sources: z.array(z.object({ sourceId: uuidSchema, sourceVersion: z.number().int().nonnegative(), label: z.string().max(160).optional() }).strict()).min(1).max(50),
  /** Independent glossary rules. Relevant IDs never participate in query expansion. */
  aliases: z.array(z.object({ phrase: z.string().min(1).max(100), alternatives: z.array(z.string().min(1).max(240)).min(1).max(5) }).strict()).max(30),
  cases: z.array(z.object({ id: z.string().min(1).max(100), group: z.enum(["english", "chinese_alias", "synonym", "context", "negative", "unjudged"]),
    query: z.string().min(1).max(240),
    /** null = no relevance judgment; [] = explicitly no relevant chunk in this corpus. */
    relevantChunkIds: z.array(uuidSchema).max(1000).nullable(),
    context: z.object({ sourceId: uuidSchema.optional(), sourceVersion: z.number().int().nonnegative().optional(), physicalPage: z.number().int().positive().optional(), terms: z.array(z.string().min(1).max(240)).max(3).optional() }).strict().optional(),
  }).strict()).min(1).max(200),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.sources.map(source => source.sourceId)).size !== value.sources.length) ctx.addIssue({ code: "custom", message: "Duplicate corpus source identity" });
  if (new Set(value.cases.map(test => test.id)).size !== value.cases.length) ctx.addIssue({ code: "custom", message: "Duplicate evaluation case identity" });
  if (value.cases.some(test => test.relevantChunkIds && new Set(test.relevantChunkIds).size !== test.relevantChunkIds.length)) ctx.addIssue({ code: "custom", message: "Duplicate relevant chunk identity" });
});
export type MaterialRetrievalEvaluation = z.infer<typeof materialRetrievalEvaluationSchema>;
