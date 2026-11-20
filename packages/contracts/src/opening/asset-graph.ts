import { z } from "zod";
import { isoDateTimeSchema, uuidSchema } from "./foundation";

export const assetGraphNodeKindSchema = z.enum([
  "course",
  "goal",
  "requirement",
  "knowledge",
  "source",
  "document",
  "exploration",
  "observation",
]);

/** Root queries explicitly exclude `"observation"` in phase 1. */
export const assetGraphRootKindSchema = z.enum([
  "course",
  "goal",
  "requirement",
  "knowledge",
  "source",
  "document",
  "exploration",
]);

export type AssetGraphNodeKind = z.infer<typeof assetGraphNodeKindSchema>;
export type AssetGraphRootKind = z.infer<typeof assetGraphRootKindSchema>;

export type AssetGraphParsedNodeId =
  | { kind: Exclude<AssetGraphNodeKind, "knowledge">; uuid: string }
  | { kind: "knowledge"; courseId: string; nodeId: string };

/** Parse a typed asset graph node id (`knowledge/<courseId>/<nodeId>` or `<kind>/<uuid>`). */
export function parseAssetGraphNodeId(value: string): AssetGraphParsedNodeId | null {
  const parts = value.split("/");
  if (parts.length === 3 && parts[0] === "knowledge") {
    const courseId = uuidSchema.safeParse(parts[1]);
    const nodeId = uuidSchema.safeParse(parts[2]);
    if (!courseId.success || !nodeId.success) return null;
    return { kind: "knowledge", courseId: courseId.data, nodeId: nodeId.data };
  }
  if (parts.length === 2) {
    const kind = assetGraphNodeKindSchema.safeParse(parts[0]);
    if (!kind.success || kind.data === "knowledge") return null;
    const uuid = uuidSchema.safeParse(parts[1]);
    if (!uuid.success) return null;
    return { kind: kind.data, uuid: uuid.data };
  }
  return null;
}

/** Format a parsed typed asset graph node id into its canonical string representation. */
export function formatAssetGraphNodeId(parsed: AssetGraphParsedNodeId): string {
  return parsed.kind === "knowledge"
    ? `knowledge/${parsed.courseId}/${parsed.nodeId}`
    : `${parsed.kind}/${parsed.uuid}`;
}

export const assetGraphNodeIdSchema = z
  .string()
  .min(1)
  .max(160)
  .refine(v => parseAssetGraphNodeId(v) !== null, "Invalid typed asset graph node id");

export const assetGraphCourseNodeIdSchema = assetGraphNodeIdSchema.refine(
  v => parseAssetGraphNodeId(v)?.kind === "course",
  "Expected a course node id",
);

export const assetGraphGoalNodeIdSchema = assetGraphNodeIdSchema.refine(
  v => parseAssetGraphNodeId(v)?.kind === "goal",
  "Expected a goal node id",
);

export type AssetGraphNodeId = z.infer<typeof assetGraphNodeIdSchema>;
export type AssetGraphCourseNodeId = z.infer<typeof assetGraphCourseNodeIdSchema>;
export type AssetGraphGoalNodeId = z.infer<typeof assetGraphGoalNodeIdSchema>;

export const assetGraphContextSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("workspace") }).strict(),
  z.object({ kind: z.literal("course"), id: assetGraphCourseNodeIdSchema }).strict(),
  z.object({ kind: z.literal("goal"), id: assetGraphGoalNodeIdSchema }).strict(),
]);

export const assetGraphLensSchema = z.enum(["all", "structure", "assets", "evidence"]);

export const assetGraphRelationSchema = z.enum([
  "scopes",
  "usesSource",
  "hasObservation",
  "promotedTo",
  "linkedTo",
  "contains",
  "prerequisite",
  "appliesTo",
  "mappedTo",
  "servesGoal",
]);

export type AssetGraphContext = z.infer<typeof assetGraphContextSchema>;
export type AssetGraphLens = z.infer<typeof assetGraphLensSchema>;
export type AssetGraphRelation = z.infer<typeof assetGraphRelationSchema>;

export const ASSET_GRAPH_LENS_RELATIONS: Record<AssetGraphLens, readonly AssetGraphRelation[]> = {
  structure: ["servesGoal", "scopes", "mappedTo", "contains", "prerequisite", "appliesTo"],
  assets: ["usesSource", "linkedTo", "promotedTo"],
  evidence: ["hasObservation"],
  all: [
    "servesGoal",
    "scopes",
    "mappedTo",
    "contains",
    "prerequisite",
    "appliesTo",
    "usesSource",
    "linkedTo",
    "promotedTo",
    "hasObservation",
  ],
};

export const ASSET_GRAPH_LENS_DEFAULT_ROOT_KINDS: Record<AssetGraphLens, readonly AssetGraphRootKind[]> = {
  structure: ["course", "goal", "requirement", "knowledge"],
  assets: ["source", "document", "exploration"],
  evidence: ["requirement"],
  all: ["course", "goal", "source", "document", "exploration"],
};

export const ASSET_GRAPH_DEFAULT_LIMIT = 20 as const;
export const ASSET_GRAPH_MAX_LIMIT = 40 as const;

const windowShape = {
  limit: z.number().int().min(1).max(ASSET_GRAPH_MAX_LIMIT).optional(),
  cursor: z.string().trim().min(1).max(2048).optional(),
  include: z.array(z.literal("summary")).min(1).max(1).optional(),
  includeKnowledgeEdgeDetails: z.boolean().optional(),
};

export const assetGraphQuerySchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("roots"),
      context: assetGraphContextSchema,
      lens: assetGraphLensSchema,
      kinds: z.array(assetGraphRootKindSchema).min(1).max(7).optional(),
      q: z.string().trim().min(1).max(200).optional(),
      ...windowShape,
    })
    .strict()
    .superRefine((value, ctx) => {
      if (value.kinds && new Set(value.kinds).size !== value.kinds.length) {
        ctx.addIssue({
          code: "custom",
          path: ["kinds"],
          message: "Duplicate root kinds are not allowed",
        });
      }
    }),
  z
    .object({
      op: z.literal("neighbors"),
      context: assetGraphContextSchema,
      lens: assetGraphLensSchema,
      focus: assetGraphNodeIdSchema,
      direction: z.enum(["in", "out", "both"]),
      relations: z.array(assetGraphRelationSchema).min(1).max(10).optional(),
      ...windowShape,
    })
    .strict()
    .superRefine((value, ctx) => {
      if (value.relations && new Set(value.relations).size !== value.relations.length) {
        ctx.addIssue({
          code: "custom",
          path: ["relations"],
          message: "Duplicate relations are not allowed",
        });
      }
    }),
  z
    .object({
      op: z.literal("detail"),
      context: assetGraphContextSchema,
      lens: assetGraphLensSchema,
      focus: assetGraphNodeIdSchema,
      includeKnowledgeEdgeDetails: z.boolean().optional(),
    })
    .strict(),
]);

export type AssetGraphQuery = z.infer<typeof assetGraphQuerySchema>;

export const assetGraphLearnerStateSchema = z.enum([
  "independent",
  "hinted",
  "retest",
  "insufficient",
]);

export const assetGraphRequirementStatusSchema = z.enum([
  "unobserved",
  "needs_correction",
  "assisted",
  "needs_verification",
  "verified",
  "blocked",
]);

export const assetGraphStateSummarySchema = z
  .object({
    learnerState: assetGraphLearnerStateSchema.nullable(),
    requirementStatus: assetGraphRequirementStatusSchema.nullable(),
  })
  .strict();

export const assetGraphKnowledgeStatusSchema = z.enum([
  "suggested",
  "supported",
  "needs_check",
]);

export const assetGraphNodeMetaSchema = z
  .object({
    occurredAt: isoDateTimeSchema.optional(),
    assistance: z.enum(["independent", "hinted", "revealed", "unknown"]).optional(),
    version: z.number().int().nonnegative().optional(),
    knowledgeStatus: assetGraphKnowledgeStatusSchema.optional(),
  })
  .strict();

export const assetGraphNodeSchema = z
  .object({
    id: assetGraphNodeIdSchema,
    kind: assetGraphNodeKindSchema,
    label: z.string().min(1).max(300),
    meta: assetGraphNodeMetaSchema.optional(),
    summary: assetGraphStateSummarySchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (parseAssetGraphNodeId(value.id)?.kind !== value.kind) {
      ctx.addIssue({
        code: "custom",
        path: ["id"],
        message: "Node id prefix must match node kind",
      });
    }
  });

export const assetGraphSharedAttributionSchema = z
  .object({
    linkId: uuidSchema,
    linkRevision: z.number().int().positive(),
    stableSkillId: uuidSchema,
    sourceCourseId: uuidSchema,
    sourceCourseTitle: z.string().min(1).max(300),
    sourceRequirementId: uuidSchema,
    sourceRequirementTitle: z.string().min(1).max(300),
    sourceRequirementRevision: z.number().int().positive(),
    targetRequirementRevision: z.number().int().positive(),
    effective: z.literal(true),
  })
  .strict();

export type AssetGraphSharedAttribution = z.infer<typeof assetGraphSharedAttributionSchema>;

const KNOWLEDGE_EDGE_RELATIONS = new Set<AssetGraphRelation>([
  "contains",
  "prerequisite",
  "appliesTo",
]);

export const assetGraphEdgeSchema = z
  .object({
    id: z.string().min(1).max(512),
    from: assetGraphNodeIdSchema,
    to: assetGraphNodeIdSchema,
    relation: assetGraphRelationSchema,
    basis: z.enum(["recorded", "derived", "suggested"]),
    knowledgeStatus: assetGraphKnowledgeStatusSchema.optional(),
    sourceNodeId: assetGraphNodeIdSchema.optional(),
    sourceVersion: z.number().int().nonnegative().optional(),
    page: z.number().int().positive().optional(),
    sharedAttribution: assetGraphSharedAttributionSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.sharedAttribution !== undefined) {
      if (value.relation !== "hasObservation") {
        ctx.addIssue({
          code: "custom",
          path: ["relation"],
          message: "sharedAttribution is only allowed on hasObservation edges",
        });
      }
      if (value.basis !== "derived") {
        ctx.addIssue({
          code: "custom",
          path: ["basis"],
          message: "sharedAttribution requires basis to be derived",
        });
      }
    }
    if (value.knowledgeStatus !== undefined) {
      if (!KNOWLEDGE_EDGE_RELATIONS.has(value.relation)) {
        ctx.addIssue({
          code: "custom",
          path: ["relation"],
          message: "knowledgeStatus is only allowed on contains, prerequisite, or appliesTo edges",
        });
      }
      if (value.knowledgeStatus === "suggested" && value.basis !== "suggested") {
        ctx.addIssue({
          code: "custom",
          path: ["basis"],
          message: "knowledgeStatus suggested requires basis to be suggested",
        });
      }
      if (
        (value.knowledgeStatus === "supported" || value.knowledgeStatus === "needs_check") &&
        value.basis !== "recorded"
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["basis"],
          message: "knowledgeStatus supported or needs_check requires basis to be recorded",
        });
      }
    }
    if (value.sourceNodeId !== undefined && (
      !KNOWLEDGE_EDGE_RELATIONS.has(value.relation) ||
      value.basis !== "recorded" ||
      parseAssetGraphNodeId(value.sourceNodeId)?.kind !== "source"
    )) {
      ctx.addIssue({
        code: "custom",
        path: ["sourceNodeId"],
        message: "sourceNodeId requires a source node id on a recorded knowledge edge",
      });
    }
  });

const SAFE_OPENING_ORIGIN = "https://aistudy.local";

function hasControlOrBackslash(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || code === 0x7f || code === 0x5c) {
      return true;
    }
  }
  return false;
}

/** Validate that a navigate action href stays on a safe same-origin `/opening/` route. */
export function isSafeOpeningNavigateHref(value: string): boolean {
  if (!value.startsWith("/opening/") || value.startsWith("//")) {
    return false;
  }
  if (hasControlOrBackslash(value) || /\s/.test(value)) {
    return false;
  }
  if (/%(?:2e|2f|5c)/i.test(value) || /(?:^|\/)\.{1,2}(?:\/|$|[?#])/.test(value)) {
    return false;
  }

  try {
    const parsed = new URL(value, SAFE_OPENING_ORIGIN);
    if (parsed.origin !== SAFE_OPENING_ORIGIN || !parsed.pathname.startsWith("/opening/")) {
      return false;
    }
    const decodedPathname = decodeURIComponent(parsed.pathname);
    if (hasControlOrBackslash(decodedPathname) || /(?:^|\/)\.{1,2}(?:\/|$)/.test(decodedPathname)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export const assetGraphActionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("navigate"),
      href: z
        .string()
        .min(1)
        .max(1000)
        .refine(
          isSafeOpeningNavigateHref,
          "Navigate action must stay on same-origin /opening/ route",
        ),
      label: z.string().min(1).max(120),
    })
    .strict(),
  z
    .object({
      kind: z.literal("startCourseRequirement"),
      courseId: uuidSchema,
      goalId: uuidSchema,
      requirementId: uuidSchema,
      expectedGoalRevision: z.number().int().positive(),
      expectedRequirementRevision: z.number().int().positive(),
      label: z.string().min(1).max(120),
    })
    .strict(),
]);

export const assetGraphDetailSchema = assetGraphStateSummarySchema
  .extend({
    id: assetGraphNodeIdSchema,
    notes: z.array(z.string().min(1).max(500)).max(20),
    actions: z.array(assetGraphActionSchema).max(10),
  })
  .strict();

export const assetGraphPageSchema = z
  .object({
    asOf: isoDateTimeSchema,
    nodes: z.array(assetGraphNodeSchema),
    edges: z.array(assetGraphEdgeSchema),
    page: z
      .object({
        nextCursor: z.string().min(1).max(2048).nullable(),
      })
      .strict(),
    completeness: z.enum(["complete", "partial"]),
    warnings: z.array(z.string().min(1).max(500)),
    detail: assetGraphDetailSchema.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const nodeIds = new Set<string>();
    for (const [index, node] of value.nodes.entries()) {
      if (nodeIds.has(node.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["nodes", index, "id"],
          message: "Duplicate node id in asset graph page",
        });
      } else {
        nodeIds.add(node.id);
      }
    }
    for (const [index, edge] of value.edges.entries()) {
      if (!nodeIds.has(edge.from)) {
        ctx.addIssue({
          code: "custom",
          path: ["edges", index, "from"],
          message: "Edge source node must exist in page nodes",
        });
      }
      if (!nodeIds.has(edge.to)) {
        ctx.addIssue({
          code: "custom",
          path: ["edges", index, "to"],
          message: "Edge target node must exist in page nodes",
        });
      }
    }
    if (value.detail !== null && !nodeIds.has(value.detail.id)) {
      ctx.addIssue({
        code: "custom",
        path: ["detail", "id"],
        message: "Detail node must exist in page nodes",
      });
    }
  });

export const assetGraphErrorCodeSchema = z.enum([
  "VALIDATION",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "WORKSPACE_FORBIDDEN",
  "NOT_FOUND",
  "CURSOR_STALE",
  "CONFLICT",
]);

export const assetGraphErrorResponseSchema = z
  .object({
    error: z
      .object({
        code: assetGraphErrorCodeSchema,
        message: z.string().min(1).max(2000),
      })
      .strict(),
  })
  .strict();

export type AssetGraphLearnerState = z.infer<typeof assetGraphLearnerStateSchema>;
export type AssetGraphRequirementStatus = z.infer<typeof assetGraphRequirementStatusSchema>;
export type AssetGraphKnowledgeStatus = z.infer<typeof assetGraphKnowledgeStatusSchema>;
export type AssetGraphStateSummary = z.infer<typeof assetGraphStateSummarySchema>;
export type AssetGraphNodeMeta = z.infer<typeof assetGraphNodeMetaSchema>;
export type AssetGraphNode = z.infer<typeof assetGraphNodeSchema>;
export type AssetGraphEdge = z.infer<typeof assetGraphEdgeSchema>;
export type AssetGraphAction = z.infer<typeof assetGraphActionSchema>;
export type AssetGraphDetail = z.infer<typeof assetGraphDetailSchema>;
export type AssetGraphPage = z.infer<typeof assetGraphPageSchema>;
export type AssetGraphErrorCode = z.infer<typeof assetGraphErrorCodeSchema>;
export type AssetGraphErrorResponse = z.infer<typeof assetGraphErrorResponseSchema>;

/** Recursively canonicalize object key ordering while preserving array order for query comparison. */
export function normalizeAssetGraphQueryValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => normalizeAssetGraphQueryValue(item));
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const entry = record[key];
      if (entry !== undefined) {
        Object.defineProperty(normalized, key, {
          value: normalizeAssetGraphQueryValue(entry),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
    }
    return normalized;
  }
  return value;
}
