import { describe, expect, it } from "vitest";
import {
  ASSET_GRAPH_DEFAULT_LIMIT,
  ASSET_GRAPH_LENS_DEFAULT_ROOT_KINDS,
  ASSET_GRAPH_LENS_RELATIONS,
  ASSET_GRAPH_MAX_LIMIT,
  assetGraphErrorResponseSchema,
  assetGraphNodeKindSchema,
  assetGraphPageSchema,
  assetGraphQuerySchema,
  formatAssetGraphNodeId,
  isSafeOpeningNavigateHref,
  normalizeAssetGraphQueryValue,
  parseAssetGraphNodeId,
  type AssetGraphParsedNodeId,
} from "./asset-graph";
import {
  assetGraphPageSchema as barrelPageSchema,
  isSafeOpeningNavigateHref as barrelIsSafeOpeningNavigateHref,
  parseAssetGraphNodeId as barrelParse,
} from "../index";

const uuid1 = "11111111-1111-4111-8111-111111111111";
const uuid2 = "22222222-2222-4222-8222-222222222222";
const uuid3 = "33333333-3333-4333-8333-333333333333";
const uuid4 = "44444444-4444-4444-8444-444444444444";
const asOf = "2026-11-18T10:00:00.000Z";

describe("asset graph typed node ids", () => {
  it("round-trips all 8 node kinds including two-uuid knowledge ids", () => {
    expect(assetGraphNodeKindSchema.options).toEqual([
      "course",
      "goal",
      "requirement",
      "knowledge",
      "source",
      "document",
      "exploration",
      "observation",
    ]);

    const simpleKinds = [
      "course",
      "goal",
      "requirement",
      "source",
      "document",
      "exploration",
      "observation",
    ] as const;

    for (const kind of simpleKinds) {
      const parsed: AssetGraphParsedNodeId = { kind, uuid: uuid1 };
      const formatted = formatAssetGraphNodeId(parsed);
      expect(formatted).toBe(`${kind}/${uuid1}`);
      expect(parseAssetGraphNodeId(formatted)).toEqual(parsed);
    }

    const knowledgeParsed: AssetGraphParsedNodeId = {
      kind: "knowledge",
      courseId: uuid1,
      nodeId: uuid2,
    };
    const knowledgeFormatted = formatAssetGraphNodeId(knowledgeParsed);
    expect(knowledgeFormatted).toBe(`knowledge/${uuid1}/${uuid2}`);
    expect(parseAssetGraphNodeId(knowledgeFormatted)).toEqual(knowledgeParsed);
    expect(barrelParse(knowledgeFormatted)).toEqual(knowledgeParsed);
  });

  it("rejects invalid prefixes, non-uuids, missing segments, and extra segments", () => {
    const invalidIds = [
      "",
      uuid1,
      `unknown/${uuid1}`,
      `course/not-a-uuid`,
      `knowledge/${uuid1}`,
      `knowledge/${uuid1}/not-a-uuid`,
      `knowledge/not-a-uuid/${uuid2}`,
      `knowledge/${uuid1}/${uuid2}/${uuid3}`,
      `course/${uuid1}/${uuid2}`,
      `course/${uuid1}/`,
      `/course/${uuid1}`,
      `course/${uuid1}?extra=1`,
      `__proto__/${uuid1}`,
    ];

    for (const candidate of invalidIds) {
      expect(parseAssetGraphNodeId(candidate)).toBeNull();
    }
  });
});

describe("assetGraphQuerySchema", () => {
  it("exposes expected lens defaults and pagination bounds", () => {
    expect(ASSET_GRAPH_DEFAULT_LIMIT).toBe(20);
    expect(ASSET_GRAPH_MAX_LIMIT).toBe(40);
    expect(ASSET_GRAPH_LENS_RELATIONS.structure).toEqual([
      "servesGoal",
      "scopes",
      "mappedTo",
      "contains",
      "prerequisite",
      "appliesTo",
    ]);
    expect(ASSET_GRAPH_LENS_RELATIONS.assets).toEqual([
      "usesSource",
      "linkedTo",
      "promotedTo",
    ]);
    expect(ASSET_GRAPH_LENS_RELATIONS.evidence).toEqual(["hasObservation"]);
    expect(ASSET_GRAPH_LENS_RELATIONS.all).toHaveLength(10);
    expect(ASSET_GRAPH_LENS_DEFAULT_ROOT_KINDS.all).toEqual([
      "course",
      "goal",
      "source",
      "document",
      "exploration",
    ]);
    expect(ASSET_GRAPH_LENS_DEFAULT_ROOT_KINDS.evidence).toEqual(["requirement"]);
  });

  it("validates roots, neighbors, and detail queries and trims string window params", () => {
    const roots = assetGraphQuerySchema.parse({
      op: "roots",
      context: { kind: "workspace" },
      lens: "all",
      kinds: ["course", "goal", "source"],
      q: "  linear span  ",
      limit: 40,
      cursor: "  cursor-token-1  ",
      include: ["summary"],
    });
    expect(roots).toEqual({
      op: "roots",
      context: { kind: "workspace" },
      lens: "all",
      kinds: ["course", "goal", "source"],
      q: "linear span",
      limit: 40,
      cursor: "cursor-token-1",
      include: ["summary"],
    });

    const neighbors = assetGraphQuerySchema.parse({
      op: "neighbors",
      context: { kind: "course", id: `course/${uuid1}` },
      lens: "structure",
      focus: `knowledge/${uuid1}/${uuid2}`,
      direction: "both",
      relations: ["contains", "prerequisite"],
      limit: 1,
    });
    expect(neighbors.op).toBe("neighbors");

    const detail = assetGraphQuerySchema.parse({
      op: "detail",
      context: { kind: "goal", id: `goal/${uuid3}` },
      lens: "evidence",
      focus: `observation/${uuid4}`,
    });
    expect(detail.op).toBe("detail");
  });

  it("rejects observation in roots.kinds, invalid limits, duplicates, context mismatches, and extra fields", () => {
    const baseRoots = {
      op: "roots" as const,
      context: { kind: "workspace" as const },
      lens: "all" as const,
    };

    expect(
      assetGraphQuerySchema.safeParse({
        ...baseRoots,
        kinds: ["observation"],
      }).success,
    ).toBe(false);

    expect(
      assetGraphQuerySchema.safeParse({
        ...baseRoots,
        kinds: [],
      }).success,
    ).toBe(false);

    expect(
      assetGraphQuerySchema.safeParse({
        ...baseRoots,
        kinds: ["course", "course"],
      }).success,
    ).toBe(false);

    for (const badLimit of [0, -1, 41, 1.5]) {
      expect(
        assetGraphQuerySchema.safeParse({
          ...baseRoots,
          limit: badLimit,
        }).success,
      ).toBe(false);
    }

    expect(
      assetGraphQuerySchema.safeParse({
        ...baseRoots,
        q: "   ",
      }).success,
    ).toBe(false);

    expect(
      assetGraphQuerySchema.safeParse({
        ...baseRoots,
        cursor: "   ",
      }).success,
    ).toBe(false);

    expect(
      assetGraphQuerySchema.safeParse({
        ...baseRoots,
        extraField: true,
      }).success,
    ).toBe(false);

    expect(
      assetGraphQuerySchema.safeParse({
        op: "roots",
        context: { kind: "course", id: `goal/${uuid1}` },
        lens: "all",
      }).success,
    ).toBe(false);

    expect(
      assetGraphQuerySchema.safeParse({
        op: "roots",
        context: { kind: "goal", id: `course/${uuid1}` },
        lens: "all",
      }).success,
    ).toBe(false);

    expect(
      assetGraphQuerySchema.safeParse({
        op: "roots",
        context: { kind: "workspace", id: `course/${uuid1}` },
        lens: "all",
      }).success,
    ).toBe(false);

    expect(
      assetGraphQuerySchema.safeParse({
        op: "neighbors",
        context: { kind: "workspace" },
        lens: "assets",
        focus: `source/${uuid1}`,
        direction: "out",
        relations: ["usesSource", "usesSource"],
      }).success,
    ).toBe(false);

    expect(
      assetGraphQuerySchema.safeParse({
        op: "neighbors",
        context: { kind: "workspace" },
        lens: "assets",
        focus: `source/${uuid1}`,
        direction: "out",
        relations: [],
      }).success,
    ).toBe(false);

    expect(
      assetGraphQuerySchema.safeParse({
        op: "neighbors",
        context: { kind: "workspace" },
        lens: "assets",
        focus: `source/${uuid1}`,
        direction: "out",
        unexpected: 1,
      }).success,
    ).toBe(false);

    expect(
      assetGraphQuerySchema.safeParse({
        op: "detail",
        context: { kind: "workspace" },
        lens: "all",
        focus: `document/${uuid1}`,
        limit: 10,
      }).success,
    ).toBe(false);

    for (const badInclude of [[], ["summary", "summary"], ["detail"]]) {
      expect(
        assetGraphQuerySchema.safeParse({
          ...baseRoots,
          include: badInclude,
        }).success,
      ).toBe(false);
    }

    expect(
      assetGraphQuerySchema.safeParse({
        ...baseRoots,
        kinds: ["course", "goal", "requirement", "knowledge", "source", "document", "exploration"],
      }).success,
    ).toBe(true);

    expect(
      assetGraphQuerySchema.safeParse({
        op: "neighbors",
        context: { kind: "workspace" },
        lens: "all",
        focus: `course/${uuid1}`,
        direction: "in",
        relations: [...ASSET_GRAPH_LENS_RELATIONS.all],
      }).success,
    ).toBe(true);
  });
});

describe("assetGraphPageSchema and assetGraphErrorResponseSchema", () => {
  it("validates roots, neighbors with summary, detail with startCourseRequirement, and partial warnings", () => {
    const rootsPage = {
      asOf,
      nodes: [
        {
          id: `course/${uuid1}`,
          kind: "course" as const,
          label: "线性代数",
        },
        {
          id: `goal/${uuid2}`,
          kind: "goal" as const,
          label: "期末冲刺",
        },
      ],
      edges: [],
      page: { nextCursor: "next-roots-1" },
      completeness: "complete" as const,
      warnings: [],
      detail: null,
    };
    expect(assetGraphPageSchema.parse(rootsPage)).toEqual(rootsPage);
    expect(barrelPageSchema.parse(rootsPage)).toEqual(rootsPage);

    const neighborsSummaryPage = {
      asOf,
      nodes: [
        {
          id: `requirement/${uuid3}`,
          kind: "requirement" as const,
          label: "线性组合与张成",
          summary: {
            learnerState: "retest" as const,
            requirementStatus: "needs_verification" as const,
          },
        },
        {
          id: `knowledge/${uuid1}/${uuid2}`,
          kind: "knowledge" as const,
          label: "向量张成空间",
          meta: {
            version: 3,
            knowledgeStatus: "supported" as const,
          },
          summary: {
            learnerState: null,
            requirementStatus: null,
          },
        },
        {
          id: `source/${uuid4}`,
          kind: "source" as const,
          label: "讲义第一章",
          meta: {
            occurredAt: asOf,
            assistance: "independent" as const,
            version: 2,
          },
        },
      ],
      edges: [
        {
          id: "edge-1",
          from: `requirement/${uuid3}`,
          to: `knowledge/${uuid1}/${uuid2}`,
          relation: "mappedTo" as const,
          basis: "recorded" as const,
        },
        {
          id: "edge-2",
          from: `requirement/${uuid3}`,
          to: `source/${uuid4}`,
          relation: "usesSource" as const,
          basis: "derived" as const,
          sourceVersion: 2,
          page: 14,
        },
      ],
      page: { nextCursor: null },
      completeness: "partial" as const,
      warnings: ["部分历史记录仍在同步中"],
      detail: {
        id: `requirement/${uuid3}`,
        learnerState: "retest" as const,
        requirementStatus: "needs_verification" as const,
        notes: ["需在独立条件下复测"],
        actions: [
          {
            kind: "startCourseRequirement" as const,
            courseId: uuid1,
            goalId: uuid2,
            requirementId: uuid3,
            expectedGoalRevision: 4,
            expectedRequirementRevision: 2,
            label: "开始本次要求练习",
          },
          {
            kind: "navigate" as const,
            href: `/opening/courses/${uuid1}`,
            label: "查看课程路线",
          },
        ],
      },
    };
    expect(assetGraphPageSchema.parse(neighborsSummaryPage)).toEqual(neighborsSummaryPage);

    const emptyPage = {
      asOf,
      nodes: [],
      edges: [],
      page: { nextCursor: null },
      completeness: "complete" as const,
      warnings: [],
      detail: null,
    };
    expect(assetGraphPageSchema.parse(emptyPage)).toEqual(emptyPage);
  });

  it("validates structured error responses including 404 NOT_FOUND and 409 CURSOR_STALE", () => {
    const notFound = {
      error: {
        code: "NOT_FOUND" as const,
        message: "Requested asset graph focus node was not found",
      },
    };
    const cursorStale = {
      error: {
        code: "CURSOR_STALE" as const,
        message: "Graph snapshot changed; restart pagination",
      },
    };

    expect(assetGraphErrorResponseSchema.parse(notFound)).toEqual(notFound);
    expect(assetGraphErrorResponseSchema.parse(cursorStale)).toEqual(cursorStale);
    for (const code of [
      "VALIDATION",
      "UNAUTHENTICATED",
      "FORBIDDEN",
      "WORKSPACE_FORBIDDEN",
      "CONFLICT",
    ] as const) {
      expect(
        assetGraphErrorResponseSchema.safeParse({
          error: { code, message: "error" },
        }).success,
      ).toBe(true);
    }

    expect(
      assetGraphErrorResponseSchema.safeParse({
        error: { code: "NOT_FOUND", message: "missing", extra: 1 },
      }).success,
    ).toBe(false);
  });

  it("rejects dangling edges, duplicate node ids, id/kind mismatches, missing detail node, and unsafe navigate hrefs", () => {
    const courseNode = {
      id: `course/${uuid1}`,
      kind: "course" as const,
      label: "微积分",
    };
    const goalNode = {
      id: `goal/${uuid2}`,
      kind: "goal" as const,
      label: "期中准备",
    };
    const validBase = {
      asOf,
      nodes: [courseNode, goalNode],
      edges: [],
      page: { nextCursor: null },
      completeness: "complete" as const,
      warnings: [],
      detail: null,
    };

    // Dangling edge endpoints
    expect(
      assetGraphPageSchema.safeParse({
        ...validBase,
        edges: [
          {
            id: "dangling-from",
            from: `requirement/${uuid3}`,
            to: goalNode.id,
            relation: "scopes",
            basis: "recorded",
          },
        ],
      }).success,
    ).toBe(false);

    expect(
      assetGraphPageSchema.safeParse({
        ...validBase,
        edges: [
          {
            id: "dangling-to",
            from: courseNode.id,
            to: `document/${uuid4}`,
            relation: "linkedTo",
            basis: "suggested",
          },
        ],
      }).success,
    ).toBe(false);

    // Duplicate node id
    expect(
      assetGraphPageSchema.safeParse({
        ...validBase,
        nodes: [courseNode, courseNode],
      }).success,
    ).toBe(false);

    // Node id / kind mismatch
    expect(
      assetGraphPageSchema.safeParse({
        ...validBase,
        nodes: [
          {
            id: `course/${uuid1}`,
            kind: "goal",
            label: "错误类型",
          },
        ],
      }).success,
    ).toBe(false);

    expect(
      assetGraphPageSchema.safeParse({
        ...validBase,
        nodes: [
          {
            id: `knowledge/${uuid1}/${uuid2}`,
            kind: "course",
            label: "错误知识点类型",
          },
        ],
      }).success,
    ).toBe(false);

    // Detail node missing from nodes
    expect(
      assetGraphPageSchema.safeParse({
        ...validBase,
        detail: {
          id: `requirement/${uuid3}`,
          learnerState: null,
          requirementStatus: null,
          notes: [],
          actions: [],
        },
      }).success,
    ).toBe(false);

    // Unsafe navigate.href
    for (const unsafeHref of [
      "https://evil.invalid/opening/courses",
      "//evil.invalid/opening/courses",
      "/api/opening/asset-graph",
      "/opening/courses path",
      "/opening/courses\u00a0path",
      "/opening/courses\\evil",
      "javascript:alert(1)",
      "/opening/courses\u0000",
      "/opening/courses\u0007",
      "/opening/courses\u001f",
      "/opening/courses\u007f",
      "/opening/courses%00",
      "/opening/courses%ZZ",
      "/opening/../admin",
      "/opening/../../api/auth/me",
      "/opening/%2e%2e/admin",
      "/opening/%2E%2E/admin",
      "/opening/%2fadmin",
      "/opening/%5cadmin",
      "/opening/..",
      "/opening/.",
      "/opening/..#fragment",
      "/opening/.?query=1",
    ]) {
      expect(isSafeOpeningNavigateHref(unsafeHref)).toBe(false);
      expect(
        assetGraphPageSchema.safeParse({
          ...validBase,
          detail: {
            id: courseNode.id,
            learnerState: null,
            requirementStatus: null,
            notes: [],
            actions: [
              {
                kind: "navigate",
                href: unsafeHref,
                label: "跳转",
              },
            ],
          },
        }).success,
      ).toBe(false);
    }

    // Safe navigate.href
    for (const safeHref of [
      "/opening/courses/10000000-0000-4000-8000-000000000001#course-goals",
      "/opening/library?tab=materials&source=40000000-0000-4000-8000-000000000001&version=1",
      "/opening/map?context=workspace",
    ]) {
      expect(isSafeOpeningNavigateHref(safeHref)).toBe(true);
      expect(barrelIsSafeOpeningNavigateHref(safeHref)).toBe(true);
      expect(
        assetGraphPageSchema.safeParse({
          ...validBase,
          detail: {
            id: courseNode.id,
            learnerState: null,
            requirementStatus: null,
            notes: [],
            actions: [
              {
                kind: "navigate",
                href: safeHref,
                label: "跳转",
              },
            ],
          },
        }).success,
      ).toBe(true);
    }
  });
});

describe("normalizeAssetGraphQueryValue", () => {
  it("normalizes nested object keys alphabetically while preserving array order", () => {
    const left = {
      z: 1,
      context: { id: `course/${uuid1}`, kind: "course" },
      op: "neighbors",
      relations: ["usesSource", "linkedTo"],
      nested: [
        { b: 2, a: 1 },
        { d: 4, c: 3 },
      ],
      omitted: undefined,
    };
    const right = {
      op: "neighbors",
      nested: [
        { a: 1, b: 2 },
        { c: 3, d: 4 },
      ],
      relations: ["usesSource", "linkedTo"],
      context: { kind: "course", id: `course/${uuid1}` },
      z: 1,
    };

    const normalizedLeft = normalizeAssetGraphQueryValue(left);
    const normalizedRight = normalizeAssetGraphQueryValue(right);

    expect(normalizedLeft).toEqual(normalizedRight);
    expect(JSON.stringify(normalizedLeft)).toBe(JSON.stringify(normalizedRight));
    expect(Object.keys(normalizedLeft as Record<string, unknown>)).toEqual([
      "context",
      "nested",
      "op",
      "relations",
      "z",
    ]);

    // Array order must be preserved, not sorted
    const reorderedArray = normalizeAssetGraphQueryValue({
      relations: ["linkedTo", "usesSource"],
    });
    expect(JSON.stringify(reorderedArray)).not.toBe(
      JSON.stringify(normalizeAssetGraphQueryValue({ relations: ["usesSource", "linkedTo"] })),
    );
  });

  it("returns primitives and null unchanged", () => {
    expect(normalizeAssetGraphQueryValue(null)).toBeNull();
    expect(normalizeAssetGraphQueryValue("all")).toBe("all");
    expect(normalizeAssetGraphQueryValue(20)).toBe(20);
    expect(normalizeAssetGraphQueryValue(false)).toBe(false);
  });
});
