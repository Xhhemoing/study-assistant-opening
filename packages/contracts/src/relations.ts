import { z } from "zod";

export const relationTypeSchema = z.enum([
  "references", "supports", "embeds", "derived_from", "related",
]);

export const relationEndpointSchema = z.object({
  type: z.enum(["document", "block"]),
  id: z.string().uuid(),
  documentId: z.string().uuid().nullable(),
  title: z.string().nullable(),
  text: z.string().nullable(),
  status: z.enum(["available", "broken"]),
});

export const knowledgeLinkSchema = z.object({
  id: z.string().uuid(),
  relationType: relationTypeSchema,
  isIncoming: z.boolean(),
  from: relationEndpointSchema,
  to: relationEndpointSchema,
  createdAt: z.string().datetime(),
});

export const knowledgeLinksResponseSchema = z.object({
  links: z.array(knowledgeLinkSchema),
});

export const indexDocumentLinksRequestSchema = z.object({
  targetTitles: z.array(z.string().trim().min(1).max(200)).max(100),
});

export const relationMutationTargetSchema = z.object({
  type: z.enum(["document", "block"]),
  id: z.string().uuid(),
}).strict();

export const createDocumentRelationRequestSchema = z.object({
  to: relationMutationTargetSchema,
  relationType: relationTypeSchema,
}).strict();

export const updateDocumentRelationRequestSchema = z.object({
  relationType: relationTypeSchema,
}).strict();

export const managedRelationSchema = z.object({
  id: z.string().uuid(),
  relationType: relationTypeSchema,
  from: relationEndpointSchema,
  to: relationEndpointSchema,
  createdAt: z.string().datetime(),
});

export const managedRelationsResponseSchema = z.object({
  relations: z.array(managedRelationSchema),
});

export type RelationType = z.infer<typeof relationTypeSchema>;
export type RelationEndpoint = z.infer<typeof relationEndpointSchema>;
export type KnowledgeLink = z.infer<typeof knowledgeLinkSchema>;
export type KnowledgeLinksResponse = z.infer<typeof knowledgeLinksResponseSchema>;
export type IndexDocumentLinksRequest = z.infer<typeof indexDocumentLinksRequestSchema>;
export type RelationMutationTarget = z.infer<typeof relationMutationTargetSchema>;
export type CreateDocumentRelationRequest = z.infer<typeof createDocumentRelationRequestSchema>;
export type UpdateDocumentRelationRequest = z.infer<typeof updateDocumentRelationRequestSchema>;
export type ManagedRelation = z.infer<typeof managedRelationSchema>;
export type ManagedRelationsResponse = z.infer<typeof managedRelationsResponseSchema>;
