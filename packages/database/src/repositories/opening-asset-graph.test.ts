import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import type {
  AssetGraphQuery,
  KnowledgeSnapshot,
  Scope,
} from "@aistudy/contracts";
import {
  OpeningAssetGraphError,
  createOpeningAssetGraphRepository,
} from "./opening-asset-graph";
import {
  computeAssetGraphQueryDigest,
  decodeAssetGraphCursor,
  encodeAssetGraphCursor,
  resolveCursorSecret,
} from "./opening-asset-graph-cursor";

const mockedReaders = vi.hoisted(() => ({
  readCourseRouteObservations: vi.fn(),
  readCourseRouteMaterials: vi.fn(),
  readCourseRouteSourceChunks: vi.fn(),
  readSharedCourseEvidence: vi.fn(),
  readOpeningLearnerState: vi.fn(),
}));

vi.mock("./opening-course-route-read", async importOriginal => {
  const actual = await importOriginal<typeof import("./opening-course-route-read")>();
  return {
    ...actual,
    readCourseRouteObservations: mockedReaders.readCourseRouteObservations,
    readCourseRouteMaterials: mockedReaders.readCourseRouteMaterials,
    readCourseRouteSourceChunks: mockedReaders.readCourseRouteSourceChunks,
  };
});

vi.mock("./opening-course-shared-skill-projection", () => ({
  readSharedCourseEvidence: mockedReaders.readSharedCourseEvidence,
}));

vi.mock("./opening-learner-state-read", () => ({
  readOpeningLearnerState: mockedReaders.readOpeningLearnerState,
}));

const SCOPE: Scope = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  ownerUserId: "22222222-2222-4222-8222-222222222222",
};

const COURSE_1 = "33333333-3333-4333-8333-333333333331";
const COURSE_2 = "33333333-3333-4333-8333-333333333332";
const GOAL_1 = "44444444-4444-4444-8444-444444444441";
const GOAL_2 = "44444444-4444-4444-8444-444444444442";
const REQ_1 = "55555555-5555-4555-8555-555555555551";
const REQ_2 = "55555555-5555-4555-8555-555555555552";
const SKILL_1 = "66666666-6666-4666-8666-666666666661";
const SKILL_2 = "66666666-6666-4666-8666-666666666662";
const KN_1 = "77777777-7777-4777-8777-777777777771";
const KN_2 = "77777777-7777-4777-8777-777777777772";
const SRC_1 = "88888888-8888-4888-8888-888888888881";
const SRC_DELETED = "88888888-8888-4888-8888-888888888889";
const DOC_1 = "99999999-9999-4999-8999-999999999991";
const DOC_2 = "99999999-9999-4999-8999-999999999992";
const EXP_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const OBS_1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const OBS_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
const OBS_DELETED = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb9";
const ATTEMPT_1 = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";

type MockDbState = {
  missingWorkspace?: boolean;
  privacyEpoch: number;
  adaptivePlanning: unknown;
  courses: Array<{ id: string; title: string; updated_at: string }>;
  goals: Array<Record<string, unknown>>;
  requirements: Array<Record<string, unknown>>;
  knowledge: Array<{ course_id: string; version: number; snapshot: unknown; updated_at: string; source_versions?: Record<string, number> }>;
  sources: Array<{
    id: string;
    name: string;
    version: number;
    upload_state: string;
    parse_state: string;
    updated_at: string;
    ai_excluded: boolean;
  }>;
  exclusions: Array<{ source_id: string }>;
  allSourceIds: Array<{ id: string }>;
  documents: Array<{
    id: string;
    title: string;
    lifecycle: string;
    current_revision_number: number;
    updated_at: string;
  }>;
  explorations: Array<{
    id: string;
    title: string;
    status: string;
    course_id: string | null;
    goal_id: string | null;
    updated_at: string;
  }>;
  memberships: Array<{
    id: string;
    course_id: string;
    asset_type: string;
    asset_id: string;
    purpose?: string | null;
    updated_at: string;
  }>;
  sourceChunks?: Array<{
    id: string;
    source_id: string;
    source_version: number;
    page: number | null;
    availability?: "available" | "unavailable";
  }>;
  assetLinks: Array<Record<string, unknown>>;
  sharedLinks?: Array<Record<string, unknown>>;
  promotions: Array<Record<string, unknown>>;
  observationHeaders: Array<Record<string, unknown>>;
  observationChains: Array<Record<string, unknown>>;
  solutionExposures: Array<{ attempt_id: string; support_domain: string }>;
};

function makeBaseState(): MockDbState {
  const snapshot: KnowledgeSnapshot = {
    courseId: COURSE_1,
    version: 3,
    nodes: [
      {
        id: KN_1,
        courseId: COURSE_1,
        label: "线性组合",
        kind: "concept",
        evidenceChunkIds: [],
        status: "supported",
      },
      {
        id: KN_2,
        courseId: COURSE_1,
        label: "线性相关",
        kind: "concept",
        evidenceChunkIds: [],
        status: "suggested",
      },
    ],
    edges: [
      {
        from: KN_1,
        to: KN_2,
        kind: "prerequisite",
        evidenceChunkIds: [],
        status: "supported",
      },
      {
        from: KN_2,
        to: KN_1,
        kind: "applies_to",
        evidenceChunkIds: [],
        status: "suggested",
      },
    ],
  };

  return {
    privacyEpoch: 2,
    adaptivePlanning: {
      autonomy: "copilot",
      coachBudgetMinutes: 60,
      courseGoals: {},
      courseGoalRefs: { [COURSE_1]: GOAL_1 },
    },
    courses: [{ id: COURSE_1, title: "Linear Algebra", updated_at: "2026-11-18T00:00:00.000Z" }],
    goals: [
      {
        id: GOAL_1,
        workspace_id: SCOPE.workspaceId,
        course_id: COURSE_1,
        course_ids: [COURSE_1],
        title: "期末冲刺",
        kind: "final-exam",
        target_date: "2026-12-20",
        exam_date: "2026-12-25",
        weekly_minutes: 180,
        priority: 3,
        learning_mode: "exam",
        success_criteria: "掌握核心矩阵计算",
        revision: 4,
        lifecycle: "active",
        maintenance_interval_days: null,
        milestones: [],
        created_at: "2026-11-01T00:00:00.000Z",
        updated_at: "2026-11-18T00:00:00.000Z",
      },
      {
        id: GOAL_2,
        workspace_id: SCOPE.workspaceId,
        course_id: COURSE_1,
        course_ids: [COURSE_1],
        title: "长期兴趣",
        kind: "interest",
        target_date: null,
        exam_date: null,
        weekly_minutes: 60,
        priority: 1,
        learning_mode: "understand",
        success_criteria: "",
        revision: 1,
        lifecycle: "paused",
        maintenance_interval_days: null,
        milestones: [],
        created_at: "2026-11-01T00:00:00.000Z",
        updated_at: "2026-11-18T00:00:00.000Z",
      },
    ],
    requirements: [
      {
        id: REQ_1,
        workspace_id: SCOPE.workspaceId,
        owner_user_id: SCOPE.ownerUserId,
        course_id: COURSE_1,
        stable_skill_id: SKILL_1,
        knowledge_node_id: KN_1,
        requirement_key: "req:span",
        title: "判断向量是否在线性张成内",
        position: 0,
        mandatory: true,
        goal_ids: [GOAL_1],
        prerequisite_ids: [],
        source_refs: [
          { sourceId: SRC_1, sourceVersion: 2, page: 3 },
          { sourceId: SRC_1, sourceVersion: 2, page: 4 },
        ],
        verification: {
          kind: "rubric",
          status: "ready",
          exerciseKeys: ["hidden-key"],
          rubric: "SECRET RUBRIC DO NOT LEAK",
          missingReasons: [],
        },
        revision: 5,
        lifecycle: "active",
        origin: "confirmed",
        approved_at: "2026-11-02T00:00:00.000Z",
        updated_at: "2026-11-18T00:00:00.000Z",
      },
      {
        id: REQ_2,
        workspace_id: SCOPE.workspaceId,
        owner_user_id: SCOPE.ownerUserId,
        course_id: COURSE_1,
        stable_skill_id: SKILL_2,
        knowledge_node_id: KN_2,
        requirement_key: "req:dependence",
        title: "判定向量组线性相关",
        position: 1,
        mandatory: false,
        goal_ids: [],
        prerequisite_ids: [REQ_1],
        source_refs: [{ sourceId: SRC_1, sourceVersion: 2 }],
        verification: {
          kind: "manual",
          status: "missing",
          exerciseKeys: [],
          rubric: null,
          missingReasons: ["尚未补充习题"],
        },
        revision: 2,
        lifecycle: "active",
        origin: "extracted",
        approved_at: null,
        updated_at: "2026-11-18T00:00:00.000Z",
      },
    ],
    knowledge: [
      {
        course_id: COURSE_1,
        version: 3,
        snapshot,
        updated_at: "2026-11-18T00:00:00.000Z",
      },
    ],
    sources: [
      {
        id: SRC_1,
        name: "Linear Algebra Notes.pdf",
        version: 2,
        upload_state: "uploaded",
        parse_state: "ready",
        updated_at: "2026-11-18T00:00:00.000Z",
        ai_excluded: false,
      },
    ],
    exclusions: [],
    allSourceIds: [{ id: SRC_1 }],
    documents: [
      {
        id: DOC_1,
        title: "线性张成推导笔记",
        lifecycle: "confirmed",
        current_revision_number: 2,
        updated_at: "2026-11-18T00:00:00.000Z",
      },
      {
        id: DOC_2,
        title: "独立探索草稿笔记",
        lifecycle: "scratch",
        current_revision_number: 1,
        updated_at: "2026-11-18T00:00:00.000Z",
      },
    ],
    explorations: [
      {
        id: EXP_1,
        title: "基与维数自由探索",
        status: "open",
        course_id: null,
        goal_id: null,
        updated_at: "2026-11-18T00:00:00.000Z",
      },
    ],
    memberships: [
      {
        id: "dddddddd-dddd-4ddd-8ddd-ddddddddddd1",
        course_id: COURSE_1,
        asset_type: "source",
        asset_id: SRC_1,
        updated_at: "2026-11-18T00:00:00.000Z",
      },
    ],
    assetLinks: [
      {
        id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1",
        asset_type: "document",
        asset_id: DOC_1,
        course_id: COURSE_1,
        goal_id: GOAL_1,
        requirement_id: REQ_1,
        revision: 1,
        updated_at: "2026-11-18T00:00:00.000Z",
      },
    ],
    promotions: [
      {
        id: "ffffffff-ffff-4fff-8fff-fffffffffff1",
        exploration_id: EXP_1,
        target_id: DOC_2,
        reviewed_at: "2026-11-18T00:00:00.000Z",
        updated_at: "2026-11-18T00:00:00.000Z",
      },
    ],
    observationHeaders: [
      {
        id: OBS_1,
        course_id: COURSE_1,
        root_id: OBS_1,
        history_revision: 1,
        workspace_history_revision: 1,
        occurred_at: "2026-11-18T01:00:00.000Z",
        submitted_at: "2026-11-18T01:00:00.000Z",
        recorded_at: "2026-11-18T01:00:00.000Z",
        requirement_key: "req:span",
        eval_req_id: REQ_1,
      },
    ],
    observationChains: [],
    solutionExposures: [],
  };
}

function createHarness(state: MockDbState) {
  const executedSql: string[] = [];
  const beginCalls: unknown[] = [];

  function serialize(strings: TemplateStringsArray, values: unknown[]): string {
    let out = "";
    for (let i = 0; i < strings.length; i += 1) {
      out += strings[i];
      if (i < values.length) {
        const val = values[i];
        if (val && typeof val === "object" && "__frag" in (val as Record<string, unknown>)) {
          out += String((val as { __frag: string }).__frag);
        } else {
          out += `$${i + 1}`;
        }
      }
    }
    return out.replace(/\s+/g, " ").trim();
  }

  const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = serialize(strings, values);
    // Support nested SQL fragments like `tx\`d.id\`` and `openingNoteReadable(...)`.
    if (text === "d.id" || text.startsWith("NOT EXISTS (SELECT 1 FROM opening_note_provenance")) {
      return { __frag: text };
    }
    executedSql.push(text);

    // Ensure sensitive content tables/columns are never queried by the repository itself.
    for (const forbidden of [
      "library_blocks",
      "exploration_blocks",
      "opening_source_chunks.text",
      "opening_course_reserved_questions",
    ]) {
      if (text.includes(forbidden)) {
        throw new Error(`Forbidden SQL reference detected: ${forbidden}`);
      }
    }

    if (text.startsWith("SET LOCAL statement_timeout")) return Promise.resolve([]);
    if (text.startsWith("SELECT transaction_timestamp()")) {
      return Promise.resolve(
        state.missingWorkspace
          ? []
          : [
              {
                snapshot_as_of: "2026-11-18T02:00:00.000Z",
                privacy_epoch: state.privacyEpoch,
                adaptive_planning: state.adaptivePlanning,
              },
            ],
      );
    }
    if (text.startsWith("SELECT id, title, updated_at FROM courses")) return Promise.resolve(state.courses);
    if (text.includes("FROM course_goals g")) return Promise.resolve(state.goals);
    if (text.startsWith("SELECT course_id FROM course_requirements")) {
      const reqId = String(values[0]);
      const req = state.requirements.find(r => String(r.id) === reqId);
      return Promise.resolve(req ? [{ course_id: req.course_id }] : []);
    }
    if (text.includes("FROM course_requirements")) {
      const courseParam = values[2];
      const allowedCourses = Array.isArray(courseParam)
        ? new Set(courseParam.map(String))
        : typeof courseParam === "string"
          ? new Set([courseParam])
          : null;
      return Promise.resolve(
        state.requirements.filter(
          r =>
            r.lifecycle === "active" &&
            (!allowedCourses || allowedCourses.has(String(r.course_id))),
        ),
      );
    }
    if (text.includes("FROM course_requirement_evidence_links l")) {
      const reqById = new Map(state.requirements.map(r => [String(r.id), r]));
      const activeCourseIds = new Set(state.courses.map(c => String(c.id)));
      const links = (state.sharedLinks ?? []).filter(l => l.active === true);
      if (text.startsWith("SELECT l.*")) {
        const targetCourseId = String(values[2]);
        return Promise.resolve(
          links.filter(l => {
            const s = reqById.get(String(l.source_requirement_id));
            const t = reqById.get(String(l.target_requirement_id));
            return (
              s &&
              t &&
              String(t.course_id) === targetCourseId &&
              activeCourseIds.has(String(s.course_id))
            );
          }),
        );
      }
      const targetCourseIds = Array.isArray(values[2]) ? new Set(values[2].map(String)) : new Set<string>();
      const allowedSourceCourses = Array.isArray(values[3])
        ? new Set(values[3].map(String))
        : activeCourseIds;
      return Promise.resolve(
        links.flatMap(l => {
          const s = reqById.get(String(l.source_requirement_id));
          const t = reqById.get(String(l.target_requirement_id));
          if (
            !s ||
            !t ||
            !targetCourseIds.has(String(t.course_id)) ||
            !allowedSourceCourses.has(String(s.course_id)) ||
            !activeCourseIds.has(String(s.course_id))
          ) {
            return [];
          }
          return [
            {
              ...l,
              source_course_id: s.course_id,
              source_requirement_title: s.title,
              target_course_id: t.course_id,
            },
          ];
        }),
      );
    }
    if (text.includes("FROM opening_course_knowledge")) {
      const courseParam = Array.isArray(values[2]) ? new Set(values[2].map(String)) : null;
      return Promise.resolve(
        state.knowledge.filter(k => !courseParam || courseParam.has(String(k.course_id))),
      );
    }
    if (text.startsWith("SELECT d.id, d.title")) return Promise.resolve(state.documents);
    if (text.startsWith("SELECT s.id, s.name")) return Promise.resolve(state.sources);
    if (text.startsWith("SELECT source_id FROM opening_privacy_exclusions")) return Promise.resolve(state.exclusions);
    if (text.startsWith("SELECT id FROM opening_sources")) return Promise.resolve(state.allSourceIds);
    if (text.startsWith("SELECT id, title, status, course_id")) return Promise.resolve(state.explorations);
    if (text.includes("FROM opening_source_chunks c")) {
      const courseIds = Array.isArray(values[1]) ? new Set(values[1].map(String)) : new Set<string>();
      const chunkIds = Array.isArray(values[2]) ? new Set(values[2].map(String)) : new Set<string>();
      const visibleSourceIds = new Set((values[3] as string[] | undefined) ?? []);
      const excluded = new Set(state.exclusions.map(e => String(e.source_id)));
      const sourceById = new Map(state.sources.map(s => [String(s.id), s]));
      const rows: Array<{
        id: string;
        source_id: string;
        source_version: number;
        page: number | null;
        course_id: string;
      }> = [];
      for (const chunk of state.sourceChunks ?? []) {
        if (!chunkIds.has(chunk.id) || !visibleSourceIds.has(chunk.source_id)) continue;
        if (chunk.availability === "unavailable") continue;
        const src = sourceById.get(chunk.source_id);
        if (!src) continue;
        if (src.upload_state !== "uploaded" || src.parse_state !== "ready") continue;
        if (src.version !== chunk.source_version) continue;
        if (excluded.has(src.id) || src.ai_excluded) continue;
        for (const membership of state.memberships) {
          if (
            membership.asset_type === "source" &&
            membership.asset_id === src.id &&
            courseIds.has(membership.course_id) &&
            (membership.purpose == null || membership.purpose === "teaching")
          ) {
            rows.push({
              id: chunk.id,
              source_id: chunk.source_id,
              source_version: chunk.source_version,
              page: chunk.page,
              course_id: membership.course_id,
            });
          }
        }
      }
      return Promise.resolve(rows);
    }
    if (text.includes("FROM course_asset_memberships")) {
      const courseParam = Array.isArray(values[1]) ? new Set(values[1].map(String)) : null;
      return Promise.resolve(
        state.memberships.filter(m => !courseParam || courseParam.has(String(m.course_id))),
      );
    }
    if (text.includes("FROM opening_learning_asset_links")) return Promise.resolve(state.assetLinks);
    if (text.includes("FROM promotion_records")) return Promise.resolve(state.promotions);
    if (text.includes("FROM opening_learning_observations o") && text.includes("AS eval_req_id")) {
      const courseParam = Array.isArray(values[2]) ? new Set(values[2].map(String)) : null;
      return Promise.resolve(
        state.observationHeaders.filter(h => !courseParam || courseParam.has(String(h.course_id))),
      );
    }
    if (text.includes("FROM opening_learning_observations o") && text.includes("AS item_source_id")) {
      return Promise.resolve(state.observationChains);
    }
    if (text.includes("FROM opening_help_exposures h")) {
      return Promise.resolve(state.solutionExposures);
    }
    throw new Error(`Unhandled SQL in unit harness: ${text}`);
  }) as unknown as Sql;

  const sql = {
    begin: vi.fn(async (mode: string, callback: (tx: Sql) => Promise<unknown>) => {
      beginCalls.push(mode);
      return callback(tx);
    }),
  } as unknown as Sql;

  const repo = createOpeningAssetGraphRepository(sql, {
    cursorSecret: "unit-test-secret-0123456789abcdef",
  });

  return { repo, sql, executedSql, beginCalls };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedReaders.readCourseRouteObservations.mockResolvedValue({ raw: [], projected: [] });
  mockedReaders.readCourseRouteMaterials.mockResolvedValue([
    { sourceId: SRC_1, sourceVersion: 2, title: "Linear Algebra Notes.pdf", available: true },
  ]);
  mockedReaders.readCourseRouteSourceChunks.mockResolvedValue([
    { id: randomUUID(), sourceId: SRC_1, sourceVersion: 2, page: 3 },
    { id: randomUUID(), sourceId: SRC_1, sourceVersion: 2, page: 4 },
  ]);
  mockedReaders.readSharedCourseEvidence.mockResolvedValue([]);
  mockedReaders.readOpeningLearnerState.mockResolvedValue({
    stateVersion: "v1",
    dataAsOf: "2026-11-18T02:00:00.000Z",
    policyVersion: "opening-evidence-v4",
    scope: { ...SCOPE, courseId: COURSE_1 },
    sourceVersions: {},
    currentSourceVersions: { [SRC_1]: 2 },
    summary: [],
    display: {
      scope: "recorded_requirements",
      counts: { independent: 0, hinted: 0, retest: 0, insufficient: 0 },
      total: 0,
      unscopedObservations: 0,
      requirements: [],
    },
    skillProfile: {
      profileVersion: "rule-profile:1",
      stateVersion: "v1",
      dataAsOf: "2026-11-18T02:00:00.000Z",
      qualificationVersion: "opening-evidence-v4",
      scope: { ...SCOPE, courseId: COURSE_1 },
      items: [],
      ungroupedObservationIds: [],
    },
    evidence: [],
    features: [],
    measurementFeatures: [],
    projection: { mode: "live_read", persistedRows: 0, eligibleHeads: 0, repairTriggered: false },
    completeness: { status: "complete", total: 0, returned: 0, gaps: [], stale: false },
  });
});

describe("opening-asset-graph-cursor", () => {
  it("resolves secret from explicit option, non-empty AUTH_SECRET, or fallback", () => {
    const original = process.env.AUTH_SECRET;
    try {
      process.env.AUTH_SECRET = "env-secret-abc";
      expect(resolveCursorSecret("explicit-secret")).toBe("explicit-secret");
      expect(resolveCursorSecret("")).toBe("env-secret-abc");
      expect(resolveCursorSecret()).toBe("env-secret-abc");

      process.env.AUTH_SECRET = "";
      const fallbackA = resolveCursorSecret();
      const fallbackB = resolveCursorSecret();
      expect(fallbackA).toBeInstanceOf(Uint8Array);
      expect(fallbackA).toBe(fallbackB);
    } finally {
      if (original === undefined) delete process.env.AUTH_SECRET;
      else process.env.AUTH_SECRET = original;
    }
  });

  it("canonicalizes queryDigest regardless of kinds/relations ordering", () => {
    const q1: AssetGraphQuery = {
      op: "roots",
      context: { kind: "workspace" },
      lens: "all",
      kinds: ["source", "course"],
      q: "linear",
    };
    const q2: AssetGraphQuery = {
      op: "roots",
      context: { kind: "workspace" },
      lens: "all",
      kinds: ["course", "source"],
      q: "linear",
    };
    expect(computeAssetGraphQueryDigest(q1)).toBe(computeAssetGraphQueryDigest(q2));

    const n1: AssetGraphQuery = {
      op: "neighbors",
      context: { kind: "course", id: `course/${COURSE_1}` },
      lens: "all",
      focus: `requirement/${REQ_1}`,
      direction: "both",
      relations: ["usesSource", "scopes"],
    };
    const n2: AssetGraphQuery = {
      op: "neighbors",
      context: { kind: "course", id: `course/${COURSE_1}` },
      lens: "all",
      focus: `requirement/${REQ_1}`,
      direction: "both",
      relations: ["scopes", "usesSource"],
    };
    expect(computeAssetGraphQueryDigest(n1)).toBe(computeAssetGraphQueryDigest(n2));
  });

  it("rejects tampered, malformed, cross-scope, cross-query, or stale cursors with CURSOR_STALE", () => {
    const secret = "test-secret";
    const queryDigest = computeAssetGraphQueryDigest({
      op: "roots",
      context: { kind: "workspace" },
      lens: "all",
    });
    const scopeFingerprint = "a".repeat(64);
    const token = encodeAssetGraphCursor(
      {
        v: 1,
        workspaceId: SCOPE.workspaceId,
        ownerUserId: SCOPE.ownerUserId,
        privacyEpoch: 2,
        queryDigest,
        scopeFingerprint,
        anchor: { op: "roots", kind: "course", id: `course/${COURSE_1}` },
      },
      secret,
    );

    expect(
      decodeAssetGraphCursor(
        token,
        { scope: SCOPE, privacyEpoch: 2, queryDigest, scopeFingerprint, op: "roots" },
        secret,
      ),
    ).toEqual({ op: "roots", kind: "course", id: `course/${COURSE_1}` });

    const [payloadPart, sigPart] = token.split(".");
    const tamperedSig = `${sigPart!.slice(0, -1)}${sigPart!.endsWith("A") ? "B" : "A"}`;
    const tamperedPayload = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payloadPart!, "base64url").toString("utf8")),
        privacyEpoch: 3,
      }),
    ).toString("base64url");

    for (const badToken of [
      "not-a-cursor",
      "a.b.c",
      "invalid!.sig",
      `${payloadPart}.${tamperedSig}`,
      `${tamperedPayload}.${sigPart}`,
    ]) {
      expect(() =>
        decodeAssetGraphCursor(
          badToken,
          { scope: SCOPE, privacyEpoch: 2, queryDigest, scopeFingerprint, op: "roots" },
          secret,
        ),
      ).toThrowError(OpeningAssetGraphError);
      try {
        decodeAssetGraphCursor(
          badToken,
          { scope: SCOPE, privacyEpoch: 2, queryDigest, scopeFingerprint, op: "roots" },
          secret,
        );
      } catch (err) {
        expect((err as OpeningAssetGraphError).code).toBe("CURSOR_STALE");
      }
    }

    // Wrong secret, scope, privacyEpoch, queryDigest, scopeFingerprint, op -> CURSOR_STALE
    expect(() =>
      decodeAssetGraphCursor(
        token,
        { scope: SCOPE, privacyEpoch: 2, queryDigest, scopeFingerprint, op: "roots" },
        "wrong-secret",
      ),
    ).toThrow(OpeningAssetGraphError);
    expect(() =>
      decodeAssetGraphCursor(
        token,
        {
          scope: { ...SCOPE, workspaceId: randomUUID() },
          privacyEpoch: 2,
          queryDigest,
          scopeFingerprint,
          op: "roots",
        },
        secret,
      ),
    ).toThrow(OpeningAssetGraphError);
    expect(() =>
      decodeAssetGraphCursor(
        token,
        { scope: SCOPE, privacyEpoch: 3, queryDigest, scopeFingerprint, op: "roots" },
        secret,
      ),
    ).toThrow(OpeningAssetGraphError);
    expect(() =>
      decodeAssetGraphCursor(
        token,
        { scope: SCOPE, privacyEpoch: 2, queryDigest: "b".repeat(64), scopeFingerprint, op: "roots" },
        secret,
      ),
    ).toThrow(OpeningAssetGraphError);
    expect(() =>
      decodeAssetGraphCursor(
        token,
        { scope: SCOPE, privacyEpoch: 2, queryDigest, scopeFingerprint: "c".repeat(64), op: "roots" },
        secret,
      ),
    ).toThrow(OpeningAssetGraphError);
    expect(() =>
      decodeAssetGraphCursor(
        token,
        { scope: SCOPE, privacyEpoch: 2, queryDigest, scopeFingerprint, op: "neighbors" },
        secret,
      ),
    ).toThrow(OpeningAssetGraphError);
  });
});

describe("createOpeningAssetGraphRepository (unit)", () => {
  it("validates scope and query before opening a transaction", async () => {
    const state = makeBaseState();
    const { repo, sql } = createHarness(state);

    await expect(
      repo.query({ workspaceId: "bad", ownerUserId: SCOPE.ownerUserId }, {
        op: "roots",
        context: { kind: "workspace" },
        lens: "all",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });

    await expect(
      repo.query(SCOPE, {
        op: "roots",
        context: { kind: "workspace" },
        lens: "all",
        kinds: ["observation" as never],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });

    expect(sql.begin).not.toHaveBeenCalled();
  });

  it("enforces read-only repeatable-read tx + statement_timeout and unified NOT_FOUND", async () => {
    const state = makeBaseState();
    state.missingWorkspace = true;
    const { repo, beginCalls, executedSql } = createHarness(state);

    await expect(
      repo.query(SCOPE, { op: "roots", context: { kind: "workspace" }, lens: "all" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "请求的资源不可用。" });

    expect(beginCalls).toEqual(["isolation level repeatable read read only"]);
    expect(executedSql[0]).toBe("SET LOCAL statement_timeout='2000ms'");

    state.missingWorkspace = false;
    await expect(
      repo.query(SCOPE, {
        op: "roots",
        context: { kind: "course", id: `course/${COURSE_2}` },
        lens: "all",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "请求的资源不可用。" });
  });

  it("paginates roots via HMAC keyset cursor and rejects tampered/cross-context/cross-lens/epoch/fingerprint cursors", async () => {
    const state = makeBaseState();
    const { repo } = createHarness(state);

    const p1 = await repo.query(SCOPE, {
      op: "roots",
      context: { kind: "workspace" },
      lens: "all",
      limit: 2,
    });
    expect(p1.nodes.map(n => n.id)).toEqual([
      `course/${COURSE_1}`,
      `document/${DOC_1}`,
    ]);
    expect(p1.page.nextCursor).toBeTruthy();

    // Changing limit between pages succeeds and returns remaining items deterministically.
    const p2 = await repo.query(SCOPE, {
      op: "roots",
      context: { kind: "workspace" },
      lens: "all",
      limit: 10,
      cursor: p1.page.nextCursor!,
    });
    expect(p2.nodes.map(n => n.id)).toEqual([
      `document/${DOC_2}`,
      `exploration/${EXP_1}`,
      `goal/${GOAL_1}`,
      `goal/${GOAL_2}`,
      `source/${SRC_1}`,
    ]);
    expect(p2.page.nextCursor).toBeNull();
    expect([...p1.nodes, ...p2.nodes].some(n => n.kind === "observation")).toBe(false);

    // Cross-context -> CURSOR_STALE
    await expect(
      repo.query(SCOPE, {
        op: "roots",
        context: { kind: "course", id: `course/${COURSE_1}` },
        lens: "all",
        cursor: p1.page.nextCursor!,
      }),
    ).rejects.toMatchObject({ code: "CURSOR_STALE" });

    // Cross-lens -> CURSOR_STALE
    await expect(
      repo.query(SCOPE, {
        op: "roots",
        context: { kind: "workspace" },
        lens: "structure",
        cursor: p1.page.nextCursor!,
      }),
    ).rejects.toMatchObject({ code: "CURSOR_STALE" });

    // Changed q -> CURSOR_STALE
    await expect(
      repo.query(SCOPE, {
        op: "roots",
        context: { kind: "workspace" },
        lens: "all",
        q: "Linear",
        cursor: p1.page.nextCursor!,
      }),
    ).rejects.toMatchObject({ code: "CURSOR_STALE" });

    // Cross-scope -> CURSOR_STALE
    await expect(
      repo.query(
        { workspaceId: SCOPE.workspaceId, ownerUserId: randomUUID() },
        { op: "roots", context: { kind: "workspace" }, lens: "all", cursor: p1.page.nextCursor! },
      ),
    ).rejects.toMatchObject({ code: "CURSOR_STALE" });

    // Privacy epoch bump -> CURSOR_STALE
    state.privacyEpoch += 1;
    await expect(
      repo.query(SCOPE, {
        op: "roots",
        context: { kind: "workspace" },
        lens: "all",
        cursor: p1.page.nextCursor!,
      }),
    ).rejects.toMatchObject({ code: "CURSOR_STALE" });

    // Restore epoch, mutate visible document title (version fingerprint drift) -> CURSOR_STALE
    state.privacyEpoch -= 1;
    state.documents[0]!.title = "修改后的笔记标题";
    await expect(
      repo.query(SCOPE, {
        op: "roots",
        context: { kind: "workspace" },
        lens: "all",
        cursor: p1.page.nextCursor!,
      }),
    ).rejects.toMatchObject({ code: "CURSOR_STALE" });
  });

  it("filters roots by q case-insensitively without SQL wildcard issues", async () => {
    const state = makeBaseState();
    state.documents[0]!.title = "100% 理解";
    const { repo } = createHarness(state);

    const res = await repo.query(SCOPE, {
      op: "roots",
      context: { kind: "workspace" },
      lens: "all",
      q: "linear",
    });
    expect(res.nodes.map(n => n.id)).toEqual([`course/${COURSE_1}`, `source/${SRC_1}`]);

    const percentRes = await repo.query(SCOPE, {
      op: "roots",
      context: { kind: "workspace" },
      lens: "all",
      q: "100%",
    });
    expect(percentRes.nodes.map(n => n.id)).toEqual([`document/${DOC_1}`]);
  });

  it("filters neighbor edges by direction and lens/relations intersection while keeping original from/to", async () => {
    const state = makeBaseState();
    const { repo } = createHarness(state);

    // Outgoing from REQ_1 in structure lens -> mappedTo -> KN_1
    const outStruct = await repo.query(SCOPE, {
      op: "neighbors",
      context: { kind: "workspace" },
      lens: "structure",
      focus: `requirement/${REQ_1}`,
      direction: "out",
    });
    expect(outStruct.edges).toEqual([
      {
        id: `recorded:mappedTo:requirement/${REQ_1}:knowledge/${COURSE_1}/${KN_1}`,
        from: `requirement/${REQ_1}`,
        to: `knowledge/${COURSE_1}/${KN_1}`,
        relation: "mappedTo",
        basis: "recorded",
      },
    ]);
    expect(outStruct.nodes.map(n => n.id)).toEqual([
      `knowledge/${COURSE_1}/${KN_1}`,
      `requirement/${REQ_1}`,
    ]);

    // Incoming to REQ_1 in structure lens -> scopes from GOAL_1 (recorded) and GOAL_2 (derived)
    const inStruct = await repo.query(SCOPE, {
      op: "neighbors",
      context: { kind: "workspace" },
      lens: "structure",
      focus: `requirement/${REQ_1}`,
      direction: "in",
    });
    expect(inStruct.edges).toEqual([
      {
        id: `recorded:scopes:goal/${GOAL_1}:requirement/${REQ_1}`,
        from: `goal/${GOAL_1}`,
        to: `requirement/${REQ_1}`,
        relation: "scopes",
        basis: "recorded",
      },
    ]);

    // Outgoing from REQ_1 in assets lens with relation intersection + keyset pagination
    const assetsPage1 = await repo.query(SCOPE, {
      op: "neighbors",
      context: { kind: "workspace" },
      lens: "assets",
      focus: `requirement/${REQ_1}`,
      direction: "both",
      relations: ["usesSource", "scopes"], // scopes excluded by assets lens!
      limit: 1,
    });
    expect(assetsPage1.edges).toHaveLength(1);
    expect(assetsPage1.edges[0]).toMatchObject({
      relation: "usesSource",
      from: `requirement/${REQ_1}`,
      to: `source/${SRC_1}`,
      sourceVersion: 2,
      page: 3,
    });
    expect(assetsPage1.page.nextCursor).toBeTruthy();

    const assetsPage2 = await repo.query(SCOPE, {
      op: "neighbors",
      context: { kind: "workspace" },
      lens: "assets",
      focus: `requirement/${REQ_1}`,
      direction: "both",
      relations: ["usesSource", "scopes"],
      limit: 1,
      cursor: assetsPage1.page.nextCursor!,
    });
    expect(assetsPage2.edges).toHaveLength(1);
    expect(assetsPage2.edges[0]).toMatchObject({
      relation: "usesSource",
      page: 4,
    });
    expect(assetsPage2.page.nextCursor).toBeNull();

    // Knowledge applies_to maps to appliesTo with suggested basis
    const knOut = await repo.query(SCOPE, {
      op: "neighbors",
      context: { kind: "workspace" },
      lens: "structure",
      focus: `knowledge/${COURSE_1}/${KN_2}`,
      direction: "out",
      includeKnowledgeEdgeDetails: true,
    });
    expect(knOut.edges).toEqual([
      {
        id: `suggested:appliesTo:knowledge/${COURSE_1}/${KN_2}:knowledge/${COURSE_1}/${KN_1}`,
        from: `knowledge/${COURSE_1}/${KN_2}`,
        to: `knowledge/${COURSE_1}/${KN_1}`,
        relation: "appliesTo",
        basis: "suggested",
        knowledgeStatus: "suggested",
        evidenceRefs: [],
      },
    ]);
  });

  it("marks completeness partial and skips derived scopes when legacyConflicts or invalid adaptive_planning exist", async () => {
    const state = makeBaseState();
    state.adaptivePlanning = {
      autonomy: "copilot",
      coachBudgetMinutes: 60,
      courseGoals: { [COURSE_1]: { targetDate: null, weeklyMinutes: 90 } },
    };
    const { repo } = createHarness(state);

    const res = await repo.query(SCOPE, {
      op: "neighbors",
      context: { kind: "course", id: `course/${COURSE_1}` },
      lens: "structure",
      focus: `goal/${GOAL_1}`,
      direction: "out",
    });
    expect(res.completeness).toBe("partial");
    expect(res.warnings.length).toBeGreaterThan(0);
    // REQ_1 has explicit goal_ids=[GOAL_1], REQ_2 has goal_ids=[] so derived scope is skipped!
    expect(res.edges.map(e => e.to)).toEqual([`requirement/${REQ_1}`]);

    // Invalid adaptive_planning JSON also marks partial and avoids derived scopes.
    state.adaptivePlanning = { broken: true };
    const invalidRes = await repo.query(SCOPE, {
      op: "neighbors",
      context: { kind: "goal", id: `goal/${GOAL_1}` },
      lens: "structure",
      focus: `goal/${GOAL_1}`,
      direction: "out",
    });
    expect(invalidRes.completeness).toBe("partial");
    expect(invalidRes.edges.map(e => e.to)).toEqual([`requirement/${REQ_1}`]);
  });

  it("de-identifies observation labels, filters privacy-excluded/deleted observations, and handles summary strictness + time ambiguity", async () => {
    const state = makeBaseState();
    state.exclusions = [{ source_id: SRC_DELETED }];
    state.observationHeaders.push(
      {
        id: OBS_2,
        course_id: COURSE_1,
        root_id: OBS_2,
        history_revision: 1,
        workspace_history_revision: 2,
        occurred_at: "2026-11-18T01:00:00.000Z",
        submitted_at: "2026-11-18T01:00:00.000Z",
        recorded_at: "2026-11-18T01:00:00.000Z",
        requirement_key: "req:span",
        eval_req_id: REQ_1,
      },
      {
        id: OBS_DELETED,
        course_id: COURSE_1,
        root_id: OBS_DELETED,
        history_revision: 1,
        workspace_history_revision: 3,
        occurred_at: "2026-11-18T01:30:00.000Z",
        submitted_at: "2026-11-18T01:30:00.000Z",
        recorded_at: "2026-11-18T01:30:00.000Z",
        requirement_key: "req:span",
        eval_req_id: REQ_1,
      },
    );

    mockedReaders.readCourseRouteObservations.mockResolvedValue({
      raw: [
        {
          id: OBS_1,
          rootObservationId: OBS_1,
          workspaceId: SCOPE.workspaceId,
          sessionId: randomUUID(),
          courseId: COURSE_1,
          activityId: randomUUID(),
          skillLabel: "SECRET RAW SKILL LABEL",
          sourceIds: [SRC_1],
          problemId: randomUUID(),
          retestId: null,
          answer: "SECRET LEARNER ANSWER",
          outcome: "correct",
          assistance: "independent",
          clientKey: "k1",
          occurredAt: "2026-11-18T01:00:00.000Z",
          submittedAt: "2026-11-18T01:00:00.000Z",
          recordedAt: "2026-11-18T01:00:00.000Z",
          sourceTurnIds: [],
          verdictSource: "deterministic",
          referenceSourceId: null,
          evidenceVerdict: "MASTERY_NOT_ESTABLISHED",
          attemptId: ATTEMPT_1,
          itemVersionId: randomUUID(),
          requirementKey: "req:span",
          startedAt: "2026-11-18T00:55:00.000Z",
          sourceVersions: { [SRC_1]: 2 },
          historyRevision: 1,
          referenceCheck: null,
        },
        {
          id: OBS_2,
          rootObservationId: OBS_2,
          workspaceId: SCOPE.workspaceId,
          sessionId: randomUUID(),
          courseId: COURSE_1,
          activityId: randomUUID(),
          skillLabel: "SECRET RAW SKILL LABEL",
          sourceIds: [SRC_1],
          problemId: randomUUID(),
          retestId: null,
          answer: "SECRET SECOND ANSWER",
          outcome: "correct",
          assistance: "hinted",
          clientKey: "k2",
          occurredAt: "2026-11-18T01:00:00.000Z",
          submittedAt: "2026-11-18T01:00:00.000Z",
          recordedAt: "2026-11-18T01:00:00.000Z",
          sourceTurnIds: [],
          verdictSource: "deterministic",
          referenceSourceId: null,
          evidenceVerdict: "MASTERY_NOT_ESTABLISHED",
          attemptId: randomUUID(),
          itemVersionId: randomUUID(),
          requirementKey: "req:span",
          startedAt: "2026-11-18T00:55:00.000Z",
          sourceVersions: { [SRC_1]: 2 },
          historyRevision: 1,
          referenceCheck: null,
        },
        {
          id: OBS_DELETED,
          rootObservationId: OBS_DELETED,
          workspaceId: SCOPE.workspaceId,
          sessionId: randomUUID(),
          courseId: COURSE_1,
          activityId: randomUUID(),
          skillLabel: "DELETED SOURCE SKILL",
          sourceIds: [SRC_DELETED],
          problemId: randomUUID(),
          retestId: null,
          answer: "SECRET DELETED ANSWER",
          outcome: "correct",
          assistance: "revealed",
          clientKey: "k3",
          occurredAt: "2026-11-18T01:30:00.000Z",
          submittedAt: "2026-11-18T01:30:00.000Z",
          recordedAt: "2026-11-18T01:30:00.000Z",
          sourceTurnIds: [],
          verdictSource: "deterministic",
          referenceSourceId: null,
          evidenceVerdict: "MASTERY_NOT_ESTABLISHED",
          attemptId: randomUUID(),
          itemVersionId: randomUUID(),
          requirementKey: "req:span",
          startedAt: "2026-11-18T01:25:00.000Z",
          sourceVersions: { [SRC_DELETED]: 1 },
          historyRevision: 1,
          referenceCheck: null,
        },
      ],
      projected: [
        {
          id: OBS_1,
          skillLabel: "SECRET RAW SKILL LABEL",
          requirementKey: "req:span",
          itemVersionId: null,
          attemptedAt: "2026-11-18T01:00:00.000Z",
          assistance: "independent",
          verifiedCorrect: "yes",
          independentAttempt: "yes",
          usableForCurrentVersion: "yes",
          problemId: null,
          courseRequirement: {
            id: REQ_1,
            revision: 5,
            stableSkillId: SKILL_1,
            requirementKey: "req:span",
          },
        },
        {
          id: OBS_2,
          skillLabel: "SECRET RAW SKILL LABEL",
          requirementKey: "req:span",
          itemVersionId: null,
          attemptedAt: "2026-11-18T01:00:00.000Z",
          assistance: "hinted",
          verifiedCorrect: "yes",
          independentAttempt: "no",
          usableForCurrentVersion: "yes",
          problemId: null,
          courseRequirement: {
            id: REQ_1,
            revision: 5,
            stableSkillId: SKILL_1,
            requirementKey: "req:span",
          },
        },
        {
          id: OBS_DELETED,
          skillLabel: "DELETED SOURCE SKILL",
          requirementKey: "req:span",
          itemVersionId: null,
          attemptedAt: "2026-11-18T01:30:00.000Z",
          assistance: "revealed",
          verifiedCorrect: "yes",
          independentAttempt: "no",
          usableForCurrentVersion: "no",
          problemId: null,
          courseRequirement: {
            id: REQ_1,
            revision: 5,
            stableSkillId: SKILL_1,
            requirementKey: "req:span",
          },
        },
      ],
    });

    const eligible = {
      independentAttempt: "yes" as const,
      verifiedCorrect: "yes" as const,
      usableForCurrentVersion: "yes" as const,
      usableForDelayedCheck: "no" as const,
      reasonCodes: [],
      policyVersion: "opening-evidence-v4",
    };

    mockedReaders.readOpeningLearnerState.mockResolvedValue({
      stateVersion: "v1",
      dataAsOf: "2026-11-18T02:00:00.000Z",
      policyVersion: "opening-evidence-v4",
      scope: { ...SCOPE, courseId: COURSE_1 },
      sourceVersions: {},
      currentSourceVersions: { [SRC_1]: 2 },
      summary: [],
      display: {
        scope: "recorded_requirements",
        counts: { independent: 0, hinted: 0, retest: 0, insufficient: 1 },
        total: 1,
        unscopedObservations: 0,
        requirements: [
          {
            courseId: COURSE_1,
            requirementKey: "req:span",
            skillLabel: "SECRET",
            state: "insufficient",
            observationIds: [OBS_1, OBS_2],
            dueRetest: false,
          },
        ],
      },
      skillProfile: {} as never,
      evidence: [],
      features: [
        {
          observationId: OBS_1,
          attemptId: ATTEMPT_1,
          courseId: COURSE_1,
          requirementKey: "req:span",
          itemVersionId: null,
          skillLabel: "SECRET",
          attemptedAt: "2026-11-18T01:00:00.000Z",
          recordedAt: "2026-11-18T01:00:00.000Z",
          sourceIds: [SRC_1],
          sourceVersions: { [SRC_1]: 2 },
          eligibility: eligible,
          availability: "available",
          views: ["independent"],
          transfer: { usable: "no", reasonCodes: [] },
          retention: {
            protocolId: null,
            earliestAt: null,
            recordedIntervalSupportCount: null,
            intervalExposureComplete: null,
          },
          gaps: [],
          outcome: "correct",
          ordinal: 0,
        },
        {
          observationId: OBS_2,
          attemptId: randomUUID(),
          courseId: COURSE_1,
          requirementKey: "req:span",
          itemVersionId: null,
          skillLabel: "SECRET",
          attemptedAt: "2026-11-18T01:00:00.000Z",
          recordedAt: "2026-11-18T01:00:00.000Z",
          sourceIds: [SRC_1],
          sourceVersions: { [SRC_1]: 2 },
          eligibility: { ...eligible, independentAttempt: "no" as const },
          availability: "available",
          views: [],
          transfer: { usable: "no", reasonCodes: [] },
          retention: {
            protocolId: null,
            earliestAt: null,
            recordedIntervalSupportCount: null,
            intervalExposureComplete: null,
          },
          gaps: [],
          outcome: "correct",
          ordinal: 1,
        },
      ],
      measurementFeatures: [],
      projection: { mode: "live_read", persistedRows: 0, eligibleHeads: 2, repairTriggered: false },
      completeness: { status: "complete", total: 2, returned: 2, gaps: [], stale: false },
    });

    const { repo } = createHarness(state);

    // 1. Deleted/excluded observation is hidden -> NOT_FOUND
    await expect(
      repo.query(SCOPE, {
        op: "detail",
        context: { kind: "workspace" },
        lens: "evidence",
        focus: `observation/${OBS_DELETED}`,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // 2. Neighbors on REQ_1 returns OBS_1 and OBS_2 with safe de-identified labels and summary with time-ambiguity -> learnerState: null
    const neighbors = await repo.query(SCOPE, {
      op: "neighbors",
      context: { kind: "workspace" },
      lens: "evidence",
      focus: `requirement/${REQ_1}`,
      direction: "out",
      include: ["summary"],
    });
    expect(neighbors.edges.map(e => e.to).sort()).toEqual([
      `observation/${OBS_1}`,
      `observation/${OBS_2}`,
    ]);
    const obs1Node = neighbors.nodes.find(n => n.id === `observation/${OBS_1}`);
    const obs2Node = neighbors.nodes.find(n => n.id === `observation/${OBS_2}`);
    expect(obs1Node?.label).toBe("独立作答记录");
    expect(obs2Node?.label).toBe("提示后作答记录");
    expect(obs1Node?.summary).toBeUndefined();

    const reqNode = neighbors.nodes.find(n => n.id === `requirement/${REQ_1}`);
    expect(reqNode?.summary).toEqual({
      learnerState: null,
      requirementStatus: "assisted",
    });
    expect(neighbors.warnings.some(w => w.includes("时间顺序歧义"))).toBe(true);

    // Ensure no raw secrets leak in serialized page
    const serialized = JSON.stringify(neighbors);
    expect(serialized).not.toContain("SECRET");

    // 3. Detail on REQ_1 includes startCourseRequirement with exact goal/requirement revisions
    const reqDetail = await repo.query(SCOPE, {
      op: "detail",
      context: { kind: "workspace" },
      lens: "all",
      focus: `requirement/${REQ_1}`,
    });
    expect(reqDetail.detail?.actions).toEqual([
      {
        kind: "startCourseRequirement",
        courseId: COURSE_1,
        goalId: GOAL_1,
        requirementId: REQ_1,
        expectedGoalRevision: 4,
        expectedRequirementRevision: 5,
        label: "开始学习此要求",
      },
      {
        kind: "navigate",
        href: `/opening/courses/${COURSE_1}`,
        label: "查看课程路线",
      },
    ]);

    // 4. Detail on exploration has empty actions (no deprecated /explore/*)
    const expDetail = await repo.query(SCOPE, {
      op: "detail",
      context: { kind: "workspace" },
      lens: "assets",
      focus: `exploration/${EXP_1}`,
    });
    expect(expDetail.detail?.actions).toEqual([]);

    // 5. Detail on unapproved requirement REQ_2 omits startCourseRequirement
    const req2Detail = await repo.query(SCOPE, {
      op: "detail",
      context: { kind: "workspace" },
      lens: "all",
      focus: `requirement/${REQ_2}`,
    });
    expect(req2Detail.detail?.actions.some(a => a.kind === "startCourseRequirement")).toBe(false);
  });

  it("isolates shared-source requirements across goals and hides no-course notes in goal context", async () => {
    const state = makeBaseState();
    state.requirements[1] = {
      ...state.requirements[1]!,
      goal_ids: [GOAL_2],
      approved_at: "2026-11-02T00:00:00.000Z",
    };
    const { repo } = createHarness(state);

    // In GOAL_1 context, neighbors of SRC_1 (shared by REQ_1 and REQ_2) only expose REQ_1 (both pages 3 & 4).
    const srcNeighbors = await repo.query(SCOPE, {
      op: "neighbors",
      context: { kind: "goal", id: `goal/${GOAL_1}` },
      lens: "assets",
      focus: `source/${SRC_1}`,
      direction: "in",
    });
    expect(srcNeighbors.edges.map(e => e.from)).toEqual([
      `requirement/${REQ_1}`,
      `requirement/${REQ_1}`,
    ]);

    // Accessing REQ_2 or no-course DOC_2 / EXP_1 in GOAL_1 context throws NOT_FOUND.
    await expect(
      repo.query(SCOPE, {
        op: "detail",
        context: { kind: "goal", id: `goal/${GOAL_1}` },
        lens: "all",
        focus: `requirement/${REQ_2}`,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await expect(
      repo.query(SCOPE, {
        op: "detail",
        context: { kind: "goal", id: `goal/${GOAL_1}` },
        lens: "assets",
        focus: `document/${DOC_2}`,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("computes strict summary states (independent/retest) and safe detail actions across remaining node kinds", async () => {
    const state = makeBaseState();
    state.sources[0]!.ai_excluded = true;
    mockedReaders.readCourseRouteMaterials.mockResolvedValue([
      { sourceId: SRC_1, sourceVersion: 2, title: "Linear Algebra Notes.pdf", available: false },
    ]);
    state.observationHeaders = [
      {
        id: OBS_1,
        course_id: COURSE_1,
        root_id: OBS_1,
        history_revision: 1,
        workspace_history_revision: 1,
        occurred_at: "2026-11-18T01:00:00.000Z",
        submitted_at: "2026-11-18T01:00:00.000Z",
        recorded_at: "2026-11-18T01:00:00.000Z",
        requirement_key: "req:span",
        eval_req_id: REQ_1,
      },
      {
        id: OBS_2,
        course_id: COURSE_1,
        root_id: OBS_2,
        history_revision: 1,
        workspace_history_revision: 2,
        occurred_at: "2026-11-18T01:10:00.000Z",
        submitted_at: "2026-11-18T01:10:00.000Z",
        recorded_at: "2026-11-18T01:10:00.000Z",
        requirement_key: "req:dependence",
        eval_req_id: REQ_2,
      },
    ];

    mockedReaders.readCourseRouteObservations.mockResolvedValue({
      raw: [
        {
          id: OBS_1,
          rootObservationId: OBS_1,
          workspaceId: SCOPE.workspaceId,
          sessionId: randomUUID(),
          courseId: COURSE_1,
          activityId: randomUUID(),
          skillLabel: "span",
          sourceIds: [SRC_1],
          problemId: randomUUID(),
          retestId: null,
          answer: "ok",
          outcome: "correct",
          assistance: "independent",
          clientKey: "k1",
          occurredAt: "2026-11-18T01:00:00.000Z",
          submittedAt: "2026-11-18T01:00:00.000Z",
          recordedAt: "2026-11-18T01:00:00.000Z",
          sourceTurnIds: [],
          verdictSource: "deterministic",
          referenceSourceId: null,
          evidenceVerdict: "MASTERY_NOT_ESTABLISHED",
          attemptId: ATTEMPT_1,
          itemVersionId: randomUUID(),
          requirementKey: "req:span",
          startedAt: "2026-11-18T00:55:00.000Z",
          sourceVersions: { [SRC_1]: 2 },
          historyRevision: 1,
          referenceCheck: null,
        },
        {
          id: OBS_2,
          rootObservationId: OBS_2,
          workspaceId: SCOPE.workspaceId,
          sessionId: randomUUID(),
          courseId: COURSE_1,
          activityId: randomUUID(),
          skillLabel: "dep",
          sourceIds: [SRC_1],
          problemId: randomUUID(),
          retestId: null,
          answer: "ok",
          outcome: "correct",
          assistance: "revealed",
          clientKey: "k2",
          occurredAt: "2026-11-18T01:10:00.000Z",
          submittedAt: "2026-11-18T01:10:00.000Z",
          recordedAt: "2026-11-18T01:10:00.000Z",
          sourceTurnIds: [],
          verdictSource: "deterministic",
          referenceSourceId: null,
          evidenceVerdict: "MASTERY_NOT_ESTABLISHED",
          attemptId: randomUUID(),
          itemVersionId: randomUUID(),
          requirementKey: "req:dependence",
          startedAt: "2026-11-18T01:05:00.000Z",
          sourceVersions: { [SRC_1]: 2 },
          historyRevision: 1,
          referenceCheck: null,
        },
      ],
      projected: [
        {
          id: OBS_1,
          skillLabel: "span",
          requirementKey: "req:span",
          itemVersionId: null,
          attemptedAt: "2026-11-18T01:00:00.000Z",
          assistance: "independent",
          verifiedCorrect: "yes",
          independentAttempt: "yes",
          usableForCurrentVersion: "yes",
          problemId: null,
          courseRequirement: {
            id: REQ_1,
            revision: 5,
            stableSkillId: SKILL_1,
            requirementKey: "req:span",
          },
        },
        {
          id: OBS_2,
          skillLabel: "dep",
          requirementKey: "req:dependence",
          itemVersionId: null,
          attemptedAt: "2026-11-18T01:10:00.000Z",
          assistance: "revealed",
          verifiedCorrect: "yes",
          independentAttempt: "no",
          usableForCurrentVersion: "yes",
          problemId: null,
          courseRequirement: {
            id: REQ_2,
            revision: 999, // Mismatched revision must NOT match REQ_2 (revision 2)!
            stableSkillId: SKILL_2,
            requirementKey: "req:dependence",
          },
        },
      ],
    });

    const eligible = {
      independentAttempt: "yes" as const,
      verifiedCorrect: "yes" as const,
      usableForCurrentVersion: "yes" as const,
      usableForDelayedCheck: "no" as const,
      reasonCodes: [],
      policyVersion: "opening-evidence-v4",
    };

    mockedReaders.readOpeningLearnerState.mockResolvedValue({
      stateVersion: "v1",
      dataAsOf: "2026-11-18T02:00:00.000Z",
      policyVersion: "opening-evidence-v4",
      scope: { ...SCOPE, courseId: COURSE_1 },
      sourceVersions: {},
      currentSourceVersions: { [SRC_1]: 2 },
      summary: [],
      display: {
        scope: "recorded_requirements",
        counts: { independent: 1, hinted: 0, retest: 1, insufficient: 0 },
        total: 2,
        unscopedObservations: 0,
        requirements: [
          {
            courseId: COURSE_1,
            requirementKey: "req:span",
            skillLabel: "span",
            state: "independent",
            observationIds: [OBS_1],
            dueRetest: false,
          },
          {
            courseId: COURSE_1,
            requirementKey: "req:dependence",
            skillLabel: "dep",
            state: "retest",
            observationIds: [OBS_2],
            dueRetest: false,
          },
        ],
      },
      skillProfile: {} as never,
      evidence: [],
      features: [
        {
          observationId: OBS_1,
          attemptId: ATTEMPT_1,
          courseId: COURSE_1,
          requirementKey: "req:span",
          itemVersionId: null,
          skillLabel: "span",
          attemptedAt: "2026-11-18T01:00:00.000Z",
          recordedAt: "2026-11-18T01:00:00.000Z",
          sourceIds: [SRC_1],
          sourceVersions: { [SRC_1]: 2 },
          eligibility: eligible,
          availability: "available",
          views: ["independent"],
          transfer: { usable: "no", reasonCodes: [] },
          retention: {
            protocolId: null,
            earliestAt: null,
            recordedIntervalSupportCount: null,
            intervalExposureComplete: null,
          },
          gaps: [],
          outcome: "correct",
          ordinal: 0,
        },
        {
          observationId: OBS_2,
          attemptId: randomUUID(),
          courseId: COURSE_1,
          requirementKey: "req:dependence",
          itemVersionId: null,
          skillLabel: "dep",
          attemptedAt: "2026-11-18T01:10:00.000Z",
          recordedAt: "2026-11-18T01:10:00.000Z",
          sourceIds: [SRC_1],
          sourceVersions: { [SRC_1]: 2 },
          eligibility: { ...eligible, independentAttempt: "no" as const },
          availability: "available",
          views: [],
          transfer: { usable: "no", reasonCodes: [] },
          retention: {
            protocolId: null,
            earliestAt: null,
            recordedIntervalSupportCount: null,
            intervalExposureComplete: null,
          },
          gaps: [],
          outcome: "correct",
          ordinal: 1,
        },
      ],
      measurementFeatures: [],
      projection: { mode: "live_read", persistedRows: 0, eligibleHeads: 2, repairTriggered: false },
      completeness: { status: "complete", total: 2, returned: 2, gaps: [], stale: false },
    });

    const { repo } = createHarness(state);

    const rootsSummary = await repo.query(SCOPE, {
      op: "roots",
      context: { kind: "workspace" },
      lens: "evidence",
      include: ["summary"],
    });
    const r1 = rootsSummary.nodes.find(n => n.id === `requirement/${REQ_1}`);
    const r2 = rootsSummary.nodes.find(n => n.id === `requirement/${REQ_2}`);
    expect(r1?.summary).toEqual({
      learnerState: "independent",
      requirementStatus: "blocked",
    });
    expect(r2?.summary).toEqual({
      learnerState: null,
      requirementStatus: "blocked",
    });

    // Solution exposure flips OBS_1's learnerState from independent to retest!
    state.solutionExposures = [{ attempt_id: ATTEMPT_1, support_domain: "math" }];
    const detailR1 = await repo.query(SCOPE, {
      op: "detail",
      context: { kind: "workspace" },
      lens: "evidence",
      focus: `requirement/${REQ_1}`,
    });
    expect(detailR1.detail?.learnerState).toBe("retest");

    // Source detail (AI-excluded still visible to owner)
    const srcDetail = await repo.query(SCOPE, {
      op: "detail",
      context: { kind: "workspace" },
      lens: "assets",
      focus: `source/${SRC_1}`,
    });
    expect(srcDetail.detail?.actions).toEqual([
      {
        kind: "navigate",
        href: `/opening/library?tab=materials&source=${SRC_1}&version=2`,
        label: "查看原资料",
      },
    ]);
    expect(srcDetail.detail?.notes.some(n => n.includes("不供 AI 使用"))).toBe(true);

    // Goal, Course, Knowledge, Document, Observation (revealed) detail actions & labels
    const goalDetail = await repo.query(SCOPE, {
      op: "detail",
      context: { kind: "workspace" },
      lens: "structure",
      focus: `goal/${GOAL_1}`,
    });
    expect(goalDetail.detail?.actions).toEqual([
      { kind: "navigate", href: `/opening/courses/${COURSE_1}#course-goals`, label: "查看课程目标" },
    ]);

    const docDetail = await repo.query(SCOPE, {
      op: "detail",
      context: { kind: "workspace" },
      lens: "assets",
      focus: `document/${DOC_1}`,
    });
    expect(docDetail.detail?.actions).toEqual([
      { kind: "navigate", href: `/opening/library/${DOC_1}`, label: "查看笔记" },
    ]);

    const obs2Detail = await repo.query(SCOPE, {
      op: "detail",
      context: { kind: "workspace" },
      lens: "evidence",
      focus: `observation/${OBS_2}`,
    });
    expect(obs2Detail.nodes[0]?.label).toBe("查看解析后作答记录");
    expect(obs2Detail.detail?.actions).toEqual([
      { kind: "navigate", href: `/opening/courses/${COURSE_1}`, label: "查看所属课程" },
    ]);

    // Cross-scope cursor check when second scope ALSO has a valid workspace
    const p1 = await repo.query(SCOPE, {
      op: "roots",
      context: { kind: "workspace" },
      lens: "all",
      limit: 1,
    });
    expect(p1.page.nextCursor).toBeTruthy();
    await expect(
      repo.query(
        { workspaceId: randomUUID(), ownerUserId: randomUUID() },
        { op: "roots", context: { kind: "workspace" }, lens: "all", cursor: p1.page.nextCursor! },
      ),
    ).rejects.toMatchObject({ code: "CURSOR_STALE" });
  });

  it("projects cross-course shared-skills evidence in course, goal, and workspace contexts while keeping homonymous knowledge nodes separate", async () => {
    const actualProjection = await vi.importActual<
      typeof import("./opening-course-shared-skill-projection")
    >("./opening-course-shared-skill-projection");
    mockedReaders.readSharedCourseEvidence.mockImplementation(
      actualProjection.readSharedCourseEvidence,
    );

    const SRC_2 = "88888888-8888-4888-8888-888888888882";
    const REQ_TARGET = "55555555-5555-4555-8555-555555555553";
    const LINK_1 = "12121212-1212-4121-8121-121212121212";
    const OBS_UNSHARED = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3";
    const CHUNK_1 = "abababab-abab-4aba-8aba-abababababa1";
    const CHUNK_2 = "abababab-abab-4aba-8aba-abababababa2";

    const state = makeBaseState();
    state.courses.push({
      id: COURSE_2,
      title: "Numerical Methods",
      updated_at: "2026-11-18T00:00:00.000Z",
    });
    state.goals[1] = {
      ...state.goals[1]!,
      course_id: COURSE_2,
      course_ids: [COURSE_2],
      title: "数值计算目标",
      lifecycle: "active",
    };
    state.adaptivePlanning = {
      autonomy: "copilot",
      coachBudgetMinutes: 60,
      courseGoals: {},
      courseGoalRefs: { [COURSE_1]: GOAL_1, [COURSE_2]: GOAL_2 },
    };
    state.requirements = [
      {
        ...state.requirements[0]!,
        revision: 1,
        verification: {
          kind: "rubric",
          status: "ready",
          exerciseKeys: ["q-span"],
          rubric: "说明向量在线性张成中的判定步骤。",
          missingReasons: [],
        },
        evidence_conditions: {
          responseFormat: "text",
          timeLimitSeconds: null,
          assistance: "independent",
        },
      },
      {
        id: REQ_2,
        workspace_id: SCOPE.workspaceId,
        owner_user_id: SCOPE.ownerUserId,
        course_id: COURSE_1,
        stable_skill_id: SKILL_2,
        knowledge_node_id: KN_2,
        requirement_key: "req:unshared",
        title: "非共享要求",
        position: 1,
        mandatory: false,
        goal_ids: [GOAL_1],
        prerequisite_ids: [],
        source_refs: [{ sourceId: SRC_1, sourceVersion: 2 }],
        verification: {
          kind: "manual",
          status: "ready",
          exerciseKeys: [],
          rubric: null,
          missingReasons: [],
        },
        revision: 1,
        lifecycle: "active",
        origin: "confirmed",
        approved_at: "2026-11-02T00:00:00.000Z",
        updated_at: "2026-11-18T00:00:00.000Z",
      },
      {
        id: REQ_TARGET,
        workspace_id: SCOPE.workspaceId,
        owner_user_id: SCOPE.ownerUserId,
        course_id: COURSE_2,
        stable_skill_id: SKILL_1,
        knowledge_node_id: KN_1,
        requirement_key: "req:nm-span",
        title: "数值分析中的线性张成应用",
        position: 0,
        mandatory: true,
        goal_ids: [GOAL_2],
        prerequisite_ids: [],
        source_refs: [{ sourceId: SRC_2, sourceVersion: 1 }],
        verification: {
          kind: "rubric",
          status: "ready",
          exerciseKeys: ["q-nm"],
          rubric: "说明向量在线性张成中的判定步骤。",
          missingReasons: [],
        },
        evidence_conditions: {
          responseFormat: "text",
          timeLimitSeconds: null,
          assistance: "independent",
        },
        revision: 2,
        lifecycle: "active",
        origin: "confirmed",
        approved_at: "2026-11-03T00:00:00.000Z",
        updated_at: "2026-11-18T00:00:00.000Z",
      },
    ];
    // Homonymous knowledge node with the exact same KN_1 UUID and label in COURSE_2.
    state.knowledge.push({
      course_id: COURSE_2,
      version: 1,
      snapshot: {
        courseId: COURSE_2,
        version: 1,
        nodes: [
          {
            id: KN_1,
            courseId: COURSE_2,
            label: "线性组合",
            kind: "concept",
            evidenceChunkIds: [],
            status: "supported",
          },
        ],
        edges: [],
      } satisfies KnowledgeSnapshot,
      updated_at: "2026-11-18T00:00:00.000Z",
    });
    state.sources.push({
      id: SRC_2,
      name: "Numerical Methods.pdf",
      version: 1,
      upload_state: "uploaded",
      parse_state: "ready",
      updated_at: "2026-11-18T00:00:00.000Z",
      ai_excluded: false,
    });
    state.allSourceIds.push({ id: SRC_2 });
    state.memberships.push({
      id: "dddddddd-dddd-4ddd-8ddd-ddddddddddd2",
      course_id: COURSE_2,
      asset_type: "source",
      asset_id: SRC_2,
      updated_at: "2026-11-18T00:00:00.000Z",
    });
    state.sharedLinks = [
      {
        id: LINK_1,
        workspace_id: SCOPE.workspaceId,
        owner_user_id: SCOPE.ownerUserId,
        source_requirement_id: REQ_1,
        source_requirement_revision: 1,
        target_requirement_id: REQ_TARGET,
        target_requirement_revision: 2,
        stable_skill_id: SKILL_1,
        revision: 1,
        active: true,
        updated_at: "2026-11-18T01:00:00.000Z",
      },
    ];
    state.observationHeaders = [
      {
        id: OBS_1,
        course_id: COURSE_1,
        root_id: OBS_1,
        history_revision: 1,
        workspace_history_revision: 1,
        occurred_at: "2026-11-18T01:00:00.000Z",
        submitted_at: "2026-11-18T01:00:00.000Z",
        recorded_at: "2026-11-18T01:00:00.000Z",
        requirement_key: "req:span",
        eval_req_id: REQ_1,
      },
      {
        id: OBS_2,
        course_id: COURSE_1,
        root_id: OBS_2,
        history_revision: 1,
        workspace_history_revision: 2,
        occurred_at: "2026-11-18T01:05:00.000Z",
        submitted_at: "2026-11-18T01:05:00.000Z",
        recorded_at: "2026-11-18T01:05:00.000Z",
        requirement_key: "req:span",
        eval_req_id: REQ_1,
      },
      {
        id: OBS_UNSHARED,
        course_id: COURSE_1,
        root_id: OBS_UNSHARED,
        history_revision: 1,
        workspace_history_revision: 3,
        occurred_at: "2026-11-18T01:10:00.000Z",
        submitted_at: "2026-11-18T01:10:00.000Z",
        recorded_at: "2026-11-18T01:10:00.000Z",
        requirement_key: "req:unshared",
        eval_req_id: REQ_2,
      },
    ];

    mockedReaders.readCourseRouteMaterials.mockImplementation(async (_db, _scope, cid) =>
      cid === COURSE_1
        ? [{ sourceId: SRC_1, sourceVersion: 2, title: "Linear Algebra Notes.pdf", available: true }]
        : [{ sourceId: SRC_2, sourceVersion: 1, title: "Numerical Methods.pdf", available: true }],
    );
    mockedReaders.readCourseRouteSourceChunks.mockImplementation(async (_db, _scope, cid) =>
      cid === COURSE_1
        ? [
            { id: CHUNK_1, sourceId: SRC_1, sourceVersion: 2, page: 3 },
            { id: CHUNK_2, sourceId: SRC_1, sourceVersion: 2, page: 4 },
          ]
        : [{ id: randomUUID(), sourceId: SRC_2, sourceVersion: 1, page: 1 }],
    );
    mockedReaders.readCourseRouteObservations.mockImplementation(async (_db, _scope, cid) => {
      if (cid !== COURSE_1) return { raw: [], projected: [] };
      return {
        raw: [
          {
            id: OBS_1,
            rootObservationId: OBS_1,
            workspaceId: SCOPE.workspaceId,
            sessionId: randomUUID(),
            courseId: COURSE_1,
            activityId: randomUUID(),
            skillLabel: "SECRET-SPAN",
            sourceIds: [SRC_1],
            problemId: randomUUID(),
            retestId: null,
            answer: "SECRET-ANS-1",
            outcome: "correct",
            assistance: "independent",
            clientKey: "k1",
            occurredAt: "2026-11-18T01:00:00.000Z",
            submittedAt: "2026-11-18T01:00:00.000Z",
            recordedAt: "2026-11-18T01:00:00.000Z",
            sourceTurnIds: [],
            verdictSource: "deterministic",
            referenceSourceId: null,
            evidenceVerdict: "MASTERY_NOT_ESTABLISHED",
            attemptId: ATTEMPT_1,
            itemVersionId: randomUUID(),
            requirementKey: "req:span",
            startedAt: "2026-11-18T00:55:00.000Z",
            sourceVersions: { [SRC_1]: 2 },
            historyRevision: 1,
            referenceCheck: null,
          },
          {
            id: OBS_2,
            rootObservationId: OBS_2,
            workspaceId: SCOPE.workspaceId,
            sessionId: randomUUID(),
            courseId: COURSE_1,
            activityId: randomUUID(),
            skillLabel: "SECRET-SPAN",
            sourceIds: [SRC_1],
            problemId: randomUUID(),
            retestId: null,
            answer: "SECRET-ANS-2",
            outcome: "correct",
            assistance: "independent",
            clientKey: "k2",
            occurredAt: "2026-11-18T01:05:00.000Z",
            submittedAt: "2026-11-18T01:05:00.000Z",
            recordedAt: "2026-11-18T01:05:00.000Z",
            sourceTurnIds: [],
            verdictSource: "deterministic",
            referenceSourceId: null,
            evidenceVerdict: "MASTERY_NOT_ESTABLISHED",
            attemptId: randomUUID(),
            itemVersionId: randomUUID(),
            requirementKey: "req:span",
            startedAt: "2026-11-18T01:00:00.000Z",
            sourceVersions: { [SRC_1]: 2 },
            historyRevision: 1,
            referenceCheck: null,
          },
          {
            id: OBS_UNSHARED,
            rootObservationId: OBS_UNSHARED,
            workspaceId: SCOPE.workspaceId,
            sessionId: randomUUID(),
            courseId: COURSE_1,
            activityId: randomUUID(),
            skillLabel: "SECRET-UNSHARED",
            sourceIds: [SRC_1],
            problemId: randomUUID(),
            retestId: null,
            answer: "SECRET-ANS-3",
            outcome: "correct",
            assistance: "independent",
            clientKey: "k3",
            occurredAt: "2026-11-18T01:10:00.000Z",
            submittedAt: "2026-11-18T01:10:00.000Z",
            recordedAt: "2026-11-18T01:10:00.000Z",
            sourceTurnIds: [],
            verdictSource: "deterministic",
            referenceSourceId: null,
            evidenceVerdict: "MASTERY_NOT_ESTABLISHED",
            attemptId: randomUUID(),
            itemVersionId: randomUUID(),
            requirementKey: "req:unshared",
            startedAt: "2026-11-18T01:08:00.000Z",
            sourceVersions: { [SRC_1]: 2 },
            historyRevision: 1,
            referenceCheck: null,
          },
        ],
        projected: [
          {
            id: OBS_1,
            skillLabel: "SECRET-SPAN",
            requirementKey: "req:span",
            itemVersionId: null,
            attemptedAt: "2026-11-18T01:00:00.000Z",
            assistance: "independent",
            verifiedCorrect: "yes",
            independentAttempt: "yes",
            usableForCurrentVersion: "yes",
            problemId: null,
            questionIdentity: "item-span-1",
            firstQuestionExposure: true,
            evidenceContext: { responseFormat: "text", elapsedSeconds: 30 },
            courseRequirement: {
              id: REQ_1,
              revision: 1,
              stableSkillId: SKILL_1,
              requirementKey: "req:span",
            },
          },
          {
            id: OBS_2,
            skillLabel: "SECRET-SPAN",
            requirementKey: "req:span",
            itemVersionId: null,
            attemptedAt: "2026-11-18T01:05:00.000Z",
            assistance: "independent",
            verifiedCorrect: "yes",
            independentAttempt: "yes",
            usableForCurrentVersion: "yes",
            problemId: null,
            questionIdentity: "item-span-2",
            firstQuestionExposure: true,
            evidenceContext: { responseFormat: "text", elapsedSeconds: 30 },
            courseRequirement: {
              id: REQ_1,
              revision: 1,
              stableSkillId: SKILL_1,
              requirementKey: "req:span",
            },
          },
          {
            id: OBS_UNSHARED,
            skillLabel: "SECRET-UNSHARED",
            requirementKey: "req:unshared",
            itemVersionId: null,
            attemptedAt: "2026-11-18T01:10:00.000Z",
            assistance: "independent",
            verifiedCorrect: "yes",
            independentAttempt: "yes",
            usableForCurrentVersion: "yes",
            problemId: null,
            questionIdentity: "item-unshared",
            firstQuestionExposure: true,
            evidenceContext: { responseFormat: "text", elapsedSeconds: 30 },
            courseRequirement: {
              id: REQ_2,
              revision: 1,
              stableSkillId: SKILL_2,
              requirementKey: "req:unshared",
            },
          },
        ],
      };
    });

    const { repo } = createHarness(state);

    // 1. Course context (COURSE_2): roots summary uses shared evidence without false missing-evidence warning.
    const courseRoots = await repo.query(SCOPE, {
      op: "roots",
      context: { kind: "course", id: `course/${COURSE_2}` },
      lens: "evidence",
      include: ["summary"],
    });
    expect(courseRoots.warnings).toEqual([]);
    expect(courseRoots.nodes.find(n => n.id === `requirement/${REQ_TARGET}`)?.summary).toEqual({
      learnerState: "independent",
      requirementStatus: "verified",
    });

    // 2. Course context neighbors on REQ_TARGET emits derived:hasObservation with sharedAttribution.
    const expectedAttr = {
      linkId: LINK_1,
      linkRevision: 1,
      stableSkillId: SKILL_1,
      sourceCourseId: COURSE_1,
      sourceCourseTitle: "Linear Algebra",
      sourceRequirementId: REQ_1,
      sourceRequirementTitle: "判断向量是否在线性张成内",
      sourceRequirementRevision: 1,
      targetRequirementRevision: 2,
      effective: true,
    };
    const courseNeighbors = await repo.query(SCOPE, {
      op: "neighbors",
      context: { kind: "course", id: `course/${COURSE_2}` },
      lens: "evidence",
      focus: `requirement/${REQ_TARGET}`,
      direction: "out",
    });
    expect(courseNeighbors.edges).toEqual([
      {
        id: `derived:hasObservation:requirement/${REQ_TARGET}:observation/${OBS_1}:link:${LINK_1}`,
        from: `requirement/${REQ_TARGET}`,
        to: `observation/${OBS_1}`,
        relation: "hasObservation",
        basis: "derived",
        sharedAttribution: expectedAttr,
      },
      {
        id: `derived:hasObservation:requirement/${REQ_TARGET}:observation/${OBS_2}:link:${LINK_1}`,
        from: `requirement/${REQ_TARGET}`,
        to: `observation/${OBS_2}`,
        relation: "hasObservation",
        basis: "derived",
        sharedAttribution: expectedAttr,
      },
    ]);

    // 3. Focusing shared observation in COURSE_2 context works for neighbors & detail; unshared observation is NOT_FOUND.
    const sharedObsIn = await repo.query(SCOPE, {
      op: "neighbors",
      context: { kind: "course", id: `course/${COURSE_2}` },
      lens: "evidence",
      focus: `observation/${OBS_1}`,
      direction: "in",
    });
    expect(sharedObsIn.edges).toHaveLength(1);
    expect(sharedObsIn.edges[0]?.sharedAttribution).toEqual(expectedAttr);

    const sharedObsDetail = await repo.query(SCOPE, {
      op: "detail",
      context: { kind: "course", id: `course/${COURSE_2}` },
      lens: "evidence",
      focus: `observation/${OBS_1}`,
    });
    expect(sharedObsDetail.detail?.notes.some(n => n.includes("Linear Algebra"))).toBe(true);
    expect(sharedObsDetail.detail?.notes.some(n => n.includes("跨课共享"))).toBe(true);
    expect(sharedObsDetail.detail?.actions).toEqual([
      { kind: "navigate", href: `/opening/courses/${COURSE_1}`, label: "查看来源课程" },
    ]);

    await expect(
      repo.query(SCOPE, {
        op: "detail",
        context: { kind: "course", id: `course/${COURSE_2}` },
        lens: "evidence",
        focus: `observation/${OBS_UNSHARED}`,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // 4. Requirement detail cites sourceCourseTitle, sourceRequirementTitle, sourceRequirementRevision, and 跨课共享有效证据.
    const reqTargetDetail = await repo.query(SCOPE, {
      op: "detail",
      context: { kind: "course", id: `course/${COURSE_2}` },
      lens: "all",
      focus: `requirement/${REQ_TARGET}`,
    });
    expect(reqTargetDetail.detail?.learnerState).toBe("independent");
    expect(reqTargetDetail.detail?.requirementStatus).toBe("verified");
    expect(
      reqTargetDetail.detail?.notes.some(
        n =>
          n.includes("跨课共享有效证据") &&
          n.includes("Linear Algebra") &&
          n.includes("判断向量是否在线性张成内") &&
          n.includes("第 1 版"),
      ),
    ).toBe(true);

    // 5. Goal context (GOAL_2 covers COURSE_2 only, not COURSE_1) still projects cross-course evidence while keeping REQ_1 hidden.
    const goalNeighbors = await repo.query(SCOPE, {
      op: "neighbors",
      context: { kind: "goal", id: `goal/${GOAL_2}` },
      lens: "evidence",
      focus: `requirement/${REQ_TARGET}`,
      direction: "out",
    });
    expect(goalNeighbors.edges).toHaveLength(2);
    await expect(
      repo.query(SCOPE, {
        op: "detail",
        context: { kind: "goal", id: `goal/${GOAL_2}` },
        lens: "all",
        focus: `requirement/${REQ_1}`,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // 6. Workspace context: observation incoming edges include both local recorded and cross-course derived; homonymous knowledge nodes remain distinct.
    const wsObsIn = await repo.query(SCOPE, {
      op: "neighbors",
      context: { kind: "workspace" },
      lens: "evidence",
      focus: `observation/${OBS_1}`,
      direction: "in",
    });
    expect(wsObsIn.edges.map(e => ({ id: e.id, basis: e.basis })).sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      {
        id: `derived:hasObservation:requirement/${REQ_TARGET}:observation/${OBS_1}:link:${LINK_1}`,
        basis: "derived",
      },
      {
        id: `recorded:hasObservation:requirement/${REQ_1}:observation/${OBS_1}`,
        basis: "recorded",
      },
    ]);

    const wsKnowledgeRoots = await repo.query(SCOPE, {
      op: "roots",
      context: { kind: "workspace" },
      lens: "structure",
      kinds: ["knowledge"],
    });
    expect(wsKnowledgeRoots.nodes.map(n => n.id)).toContain(`knowledge/${COURSE_1}/${KN_1}`);
    expect(wsKnowledgeRoots.nodes.map(n => n.id)).toContain(`knowledge/${COURSE_2}/${KN_1}`);

    // 7. dueRetest flips shared summary learnerState to "retest".
    const baseLearnerState = await mockedReaders.readOpeningLearnerState(
      {} as never,
      SCOPE,
      { courseId: COURSE_2 },
    );
    mockedReaders.readOpeningLearnerState.mockResolvedValueOnce({
      ...baseLearnerState,
      display: {
        ...baseLearnerState.display,
        requirements: [
          {
            courseId: COURSE_2,
            requirementKey: "req:nm-span",
            skillLabel: "数值分析中的线性张成应用",
            state: "retest",
            observationIds: [],
            dueRetest: true,
          },
        ],
      },
    });
    const retestRoots = await repo.query(SCOPE, {
      op: "roots",
      context: { kind: "course", id: `course/${COURSE_2}` },
      lens: "evidence",
      include: ["summary"],
    });
    expect(retestRoots.nodes.find(n => n.id === `requirement/${REQ_TARGET}`)?.summary).toEqual({
      learnerState: "retest",
      requirementStatus: "verified",
    });
  });

  it("invalidates shared-skill cursors with CURSOR_STALE and hides shared evidence on unlink, revision bump, or source material exclusion", async () => {
    const actualProjection = await vi.importActual<
      typeof import("./opening-course-shared-skill-projection")
    >("./opening-course-shared-skill-projection");
    mockedReaders.readSharedCourseEvidence.mockImplementation(
      actualProjection.readSharedCourseEvidence,
    );

    const SRC_2 = "88888888-8888-4888-8888-888888888882";
    const REQ_TARGET = "55555555-5555-4555-8555-555555555553";
    const LINK_1 = "12121212-1212-4121-8121-121212121212";
    const CHUNK_1 = "abababab-abab-4aba-8aba-abababababa1";

    const buildState = () => {
      const state = makeBaseState();
      state.courses.push({
        id: COURSE_2,
        title: "Course Two",
        updated_at: "2026-11-18T00:00:00.000Z",
      });
      state.requirements = [
        {
          ...state.requirements[0]!,
          revision: 1,
          verification: {
            kind: "rubric",
            status: "ready",
            exerciseKeys: ["q1"],
            rubric: "完整推导理由",
            missingReasons: [],
          },
          evidence_conditions: {
            responseFormat: "text",
            timeLimitSeconds: null,
            assistance: "independent",
          },
        },
        {
          id: REQ_TARGET,
          workspace_id: SCOPE.workspaceId,
          owner_user_id: SCOPE.ownerUserId,
          course_id: COURSE_2,
          stable_skill_id: SKILL_1,
          knowledge_node_id: null,
          requirement_key: "req:c2",
          title: "目标要求",
          position: 0,
          mandatory: true,
          goal_ids: [],
          prerequisite_ids: [],
          source_refs: [{ sourceId: SRC_2, sourceVersion: 1 }],
          verification: {
            kind: "rubric",
            status: "ready",
            exerciseKeys: ["q2"],
            rubric: "完整推导理由",
            missingReasons: [],
          },
          evidence_conditions: {
            responseFormat: "text",
            timeLimitSeconds: null,
            assistance: "independent",
          },
          revision: 1,
          lifecycle: "active",
          origin: "confirmed",
          approved_at: "2026-11-02T00:00:00.000Z",
          updated_at: "2026-11-18T00:00:00.000Z",
        },
      ];
      state.sources.push({
        id: SRC_2,
        name: "C2.pdf",
        version: 1,
        upload_state: "uploaded",
        parse_state: "ready",
        updated_at: "2026-11-18T00:00:00.000Z",
        ai_excluded: false,
      });
      state.allSourceIds.push({ id: SRC_2 });
      state.sharedLinks = [
        {
          id: LINK_1,
          workspace_id: SCOPE.workspaceId,
          owner_user_id: SCOPE.ownerUserId,
          source_requirement_id: REQ_1,
          source_requirement_revision: 1,
          target_requirement_id: REQ_TARGET,
          target_requirement_revision: 1,
          stable_skill_id: SKILL_1,
          revision: 1,
          active: true,
          updated_at: "2026-11-18T01:00:00.000Z",
        },
      ];
      state.observationHeaders = [
        {
          id: OBS_1,
          course_id: COURSE_1,
          root_id: OBS_1,
          history_revision: 1,
          workspace_history_revision: 1,
          occurred_at: "2026-11-18T01:00:00.000Z",
          submitted_at: "2026-11-18T01:00:00.000Z",
          recorded_at: "2026-11-18T01:00:00.000Z",
          requirement_key: "req:span",
          eval_req_id: REQ_1,
        },
        {
          id: OBS_2,
          course_id: COURSE_1,
          root_id: OBS_2,
          history_revision: 1,
          workspace_history_revision: 2,
          occurred_at: "2026-11-18T01:05:00.000Z",
          submitted_at: "2026-11-18T01:05:00.000Z",
          recorded_at: "2026-11-18T01:05:00.000Z",
          requirement_key: "req:span",
          eval_req_id: REQ_1,
        },
      ];
      return state;
    };

    const state = buildState();
    mockedReaders.readCourseRouteMaterials.mockImplementation(async (_db, _scope, cid) =>
      cid === COURSE_1
        ? [
            {
              sourceId: SRC_1,
              sourceVersion: 2,
              title: "Linear Algebra Notes.pdf",
              available: !state.exclusions.some(e => e.source_id === SRC_1),
            },
          ]
        : [{ sourceId: SRC_2, sourceVersion: 1, title: "C2.pdf", available: true }],
    );
    mockedReaders.readCourseRouteSourceChunks.mockImplementation(async (_db, _scope, cid) =>
      cid === COURSE_1
        ? state.exclusions.some(e => e.source_id === SRC_1)
          ? []
          : [
              { id: CHUNK_1, sourceId: SRC_1, sourceVersion: 2, page: 3 },
              { id: randomUUID(), sourceId: SRC_1, sourceVersion: 2, page: 4 },
            ]
        : [{ id: randomUUID(), sourceId: SRC_2, sourceVersion: 1, page: 1 }],
    );
    mockedReaders.readCourseRouteObservations.mockImplementation(async (_db, _scope, cid) => {
      if (cid !== COURSE_1) return { raw: [], projected: [] };
      const makeObs = (id: string, qid: string) => ({
        raw: {
          id,
          rootObservationId: id,
          workspaceId: SCOPE.workspaceId,
          sessionId: randomUUID(),
          courseId: COURSE_1,
          activityId: randomUUID(),
          skillLabel: "span",
          sourceIds: [SRC_1],
          problemId: randomUUID(),
          retestId: null,
          answer: "ans",
          outcome: "correct" as const,
          assistance: "independent" as const,
          clientKey: id,
          occurredAt: "2026-11-18T01:00:00.000Z",
          submittedAt: "2026-11-18T01:00:00.000Z",
          recordedAt: "2026-11-18T01:00:00.000Z",
          sourceTurnIds: [],
          verdictSource: "deterministic" as const,
          referenceSourceId: null,
          evidenceVerdict: "MASTERY_NOT_ESTABLISHED" as const,
          attemptId: randomUUID(),
          itemVersionId: randomUUID(),
          requirementKey: "req:span",
          startedAt: "2026-11-18T00:55:00.000Z",
          sourceVersions: { [SRC_1]: 2 },
          historyRevision: 1,
          referenceCheck: null,
        },
        projected: {
          id,
          skillLabel: "span",
          requirementKey: "req:span",
          itemVersionId: null,
          attemptedAt: "2026-11-18T01:00:00.000Z",
          assistance: "independent" as const,
          verifiedCorrect: "yes" as const,
          independentAttempt: "yes" as const,
          usableForCurrentVersion: "yes" as const,
          problemId: null,
          questionIdentity: qid,
          firstQuestionExposure: true,
          evidenceContext: { responseFormat: "text" as const, elapsedSeconds: 20 },
          courseRequirement: {
            id: REQ_1,
            revision: 1,
            stableSkillId: SKILL_1,
            requirementKey: "req:span",
          },
        },
      });
      const o1 = makeObs(OBS_1, "q1");
      const o2 = makeObs(OBS_2, "q2");
      return { raw: [o1.raw, o2.raw], projected: [o1.projected, o2.projected] };
    });

    const { repo } = createHarness(state);
    const getFirstPage = () =>
      repo.query(SCOPE, {
        op: "neighbors",
        context: { kind: "course", id: `course/${COURSE_2}` },
        lens: "evidence",
        focus: `requirement/${REQ_TARGET}`,
        direction: "out",
        limit: 1,
      });

    // 1. Unlink (active = false) -> CURSOR_STALE + hides shared edge & observation
    const p1 = await getFirstPage();
    expect(p1.page.nextCursor).toBeTruthy();
    state.sharedLinks![0]!.active = false;
    await expect(
      repo.query(SCOPE, {
        op: "neighbors",
        context: { kind: "course", id: `course/${COURSE_2}` },
        lens: "evidence",
        focus: `requirement/${REQ_TARGET}`,
        direction: "out",
        limit: 1,
        cursor: p1.page.nextCursor!,
      }),
    ).rejects.toMatchObject({ code: "CURSOR_STALE" });
    expect((await getFirstPage()).edges).toEqual([]);

    // 2. Restore link, then bump source requirement revision -> CURSOR_STALE + hides shared edge
    state.sharedLinks![0]!.active = true;
    const p2 = await getFirstPage();
    expect(p2.page.nextCursor).toBeTruthy();
    state.requirements[0]!.revision = 2;
    await expect(
      repo.query(SCOPE, {
        op: "neighbors",
        context: { kind: "course", id: `course/${COURSE_2}` },
        lens: "evidence",
        focus: `requirement/${REQ_TARGET}`,
        direction: "out",
        limit: 1,
        cursor: p2.page.nextCursor!,
      }),
    ).rejects.toMatchObject({ code: "CURSOR_STALE" });
    expect((await getFirstPage()).edges).toEqual([]);

    // 3. Restore source revision, then privacy-exclude source material (without bumping privacyEpoch) -> CURSOR_STALE + hides shared evidence
    state.requirements[0]!.revision = 1;
    const p3 = await getFirstPage();
    expect(p3.page.nextCursor).toBeTruthy();
    state.exclusions = [{ source_id: SRC_1 }];
    state.sources[0]!.ai_excluded = true;
    await expect(
      repo.query(SCOPE, {
        op: "neighbors",
        context: { kind: "course", id: `course/${COURSE_2}` },
        lens: "evidence",
        focus: `requirement/${REQ_TARGET}`,
        direction: "out",
        limit: 1,
        cursor: p3.page.nextCursor!,
      }),
    ).rejects.toMatchObject({ code: "CURSOR_STALE" });
    expect((await getFirstPage()).edges).toEqual([]);
  });
});

describe("honest knowledgeStatus edge projection and live chunk re-verification", () => {
  const CHUNK_1 = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";
  const CHUNK_2 = "dddddddd-dddd-4ddd-8ddd-ddddddddddd2";
  const CHUNK_ZERO_PAGE = "dddddddd-dddd-4ddd-8ddd-ddddddddddd3";
  const KN_3 = "77777777-7777-4777-8777-777777777773";

  it("projects verified sourceNodeId/sourceVersion/positive page for supported edges and omits non-positive or null page", async () => {
    const state = makeBaseState();
    state.sourceChunks = [
      { id: CHUNK_1, source_id: SRC_1, source_version: 2, page: 12 },
      { id: CHUNK_ZERO_PAGE, source_id: SRC_1, source_version: 2, page: 0 },
    ];
    state.knowledge = [
      {
        course_id: COURSE_1,
        version: 4,
        updated_at: "2026-11-18T01:00:00.000Z",
        snapshot: {
          courseId: COURSE_1,
          version: 4,
          nodes: [
            { id: KN_1, courseId: COURSE_1, label: "线性组合", kind: "concept", evidenceChunkIds: [CHUNK_1], status: "supported" },
            { id: KN_2, courseId: COURSE_1, label: "线性相关", kind: "concept", evidenceChunkIds: [CHUNK_ZERO_PAGE], status: "supported" },
            { id: KN_3, courseId: COURSE_1, label: "线性无关", kind: "concept", evidenceChunkIds: [], status: "needs_check" },
          ],
          edges: [
            { from: KN_1, to: KN_2, kind: "prerequisite", evidenceChunkIds: [CHUNK_1], status: "supported" },
            { from: KN_1, to: KN_3, kind: "contains", evidenceChunkIds: [CHUNK_ZERO_PAGE], status: "supported" },
          ],
        } satisfies KnowledgeSnapshot,
      },
    ];
    const { repo, executedSql } = createHarness(state);

    const out = await repo.query(SCOPE, {
      op: "neighbors",
      context: { kind: "course", id: `course/${COURSE_1}` },
      lens: "structure",
      focus: `knowledge/${COURSE_1}/${KN_1}`,
      direction: "out",
        includeKnowledgeEdgeDetails: true,
    });

    const prereq = out.edges.find(e => e.relation === "prerequisite");
    expect(prereq).toEqual({
      id: `recorded:prerequisite:knowledge/${COURSE_1}/${KN_1}:knowledge/${COURSE_1}/${KN_2}`,
      from: `knowledge/${COURSE_1}/${KN_1}`,
      to: `knowledge/${COURSE_1}/${KN_2}`,
      relation: "prerequisite",
      basis: "recorded",
      knowledgeStatus: "supported",
      sourceNodeId: `source/${SRC_1}`,
      sourceVersion: 2,
      page: 12,
      evidenceRefs: [{ sourceId: SRC_1, sourceVersion: 2, chunkId: CHUNK_1, page: 12 }],
    });

    const contains = out.edges.find(e => e.relation === "contains");
    expect(contains).toEqual({
      id: `recorded:contains:knowledge/${COURSE_1}/${KN_1}:knowledge/${COURSE_1}/${KN_3}`,
      from: `knowledge/${COURSE_1}/${KN_1}`,
      to: `knowledge/${COURSE_1}/${KN_3}`,
      relation: "contains",
      basis: "recorded",
      knowledgeStatus: "supported",
      sourceNodeId: `source/${SRC_1}`,
      sourceVersion: 2,
      evidenceRefs: [{ sourceId: SRC_1, sourceVersion: 2, chunkId: CHUNK_ZERO_PAGE }],
    });
    expect("page" in contains!).toBe(false);

    // Ensure SQL never selects chunk text or chunk_index.
    const chunkQueries = executedSql.filter(q => q.includes("FROM opening_source_chunks c"));
    expect(chunkQueries).toHaveLength(1);
    expect(chunkQueries[0]).not.toMatch(/\bc\.text\b|\bchunk_index\b/);
  });

  it("read-only downgrades supported edges to needs_check and omits provenance when chunks fail live re-verification", async () => {
    const buildState = () => {
      const state = makeBaseState();
      state.sourceChunks = [{ id: CHUNK_1, source_id: SRC_1, source_version: 2, page: 7 }];
      state.knowledge = [
        {
          course_id: COURSE_1,
          version: 4,
          updated_at: "2026-11-18T01:00:00.000Z",
          snapshot: {
            courseId: COURSE_1,
            version: 4,
            nodes: [
              { id: KN_1, courseId: COURSE_1, label: "线性组合", kind: "concept", evidenceChunkIds: [CHUNK_1], status: "supported" },
              { id: KN_2, courseId: COURSE_1, label: "线性相关", kind: "concept", evidenceChunkIds: [], status: "supported" },
            ],
            edges: [
              { from: KN_1, to: KN_2, kind: "prerequisite", evidenceChunkIds: [CHUNK_1], status: "supported" },
            ],
          } satisfies KnowledgeSnapshot,
        },
      ];
      return state;
    };

    const queryEdge = async (state: MockDbState) => {
      const { repo } = createHarness(state);
      const res = await repo.query(SCOPE, {
        op: "neighbors",
        context: { kind: "course", id: `course/${COURSE_1}` },
        lens: "structure",
        focus: `knowledge/${COURSE_1}/${KN_1}`,
        direction: "out",
        includeKnowledgeEdgeDetails: true,
      });
      return res.edges.find(e => e.relation === "prerequisite");
    };

    for (const condition of ["excluded", "deleted", "reference", "mock_exam", "practice"]) {
      const state = buildState();
      state.knowledge[0]!.source_versions = { [SRC_1]: 2 };
      if (condition === "excluded") state.exclusions = [{ source_id: SRC_1 }];
      else if (condition === "deleted") state.allSourceIds = state.allSourceIds.filter(row => row.id !== SRC_1);
      else state.memberships[0]!.purpose = condition;

      const { repo } = createHarness(state);
      const focus = `knowledge/${COURSE_1}/${KN_1}`;
      const context = { kind: "course", id: `course/${COURSE_1}` } as const;
      const roots = await repo.query(SCOPE, { op: "roots", context, lens: "structure", kinds: ["knowledge"] });
      expect(roots.nodes).toEqual([]);
      await expect(repo.query(SCOPE, { op: "detail", context, lens: "structure", focus }))
        .rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(queryEdge(state)).rejects.toMatchObject({ code: "NOT_FOUND" });
    }

    const partial = buildState();
    partial.knowledge[0]!.source_versions = { [SRC_1]: 2 };
    (partial.knowledge[0]!.snapshot as KnowledgeSnapshot).edges[0]!.evidenceChunkIds.push(CHUNK_2);
    expect(await queryEdge(partial)).toEqual({
      id: `recorded:prerequisite:knowledge/${COURSE_1}/${KN_1}:knowledge/${COURSE_1}/${KN_2}`,
      from: `knowledge/${COURSE_1}/${KN_1}`,
      to: `knowledge/${COURSE_1}/${KN_2}`,
      relation: "prerequisite",
      basis: "recorded",
      knowledgeStatus: "needs_check",
      evidenceRefs: [],
    });

    // 3. Unlinked membership -> needs_check without provenance
    const sUnlinked = buildState();
    sUnlinked.memberships = [];
    expect(await queryEdge(sUnlinked)).toEqual({
      id: `recorded:prerequisite:knowledge/${COURSE_1}/${KN_1}:knowledge/${COURSE_1}/${KN_2}`,
      from: `knowledge/${COURSE_1}/${KN_1}`,
      to: `knowledge/${COURSE_1}/${KN_2}`,
      relation: "prerequisite",
      basis: "recorded",
      knowledgeStatus: "needs_check",
      evidenceRefs: [],
    });

    // 4. Unavailable source version -> needs_check without provenance
    const sUnavailable = buildState();
    sUnavailable.sourceChunks![0]!.availability = "unavailable";
    expect(await queryEdge(sUnavailable)).toEqual({
      id: `recorded:prerequisite:knowledge/${COURSE_1}/${KN_1}:knowledge/${COURSE_1}/${KN_2}`,
      from: `knowledge/${COURSE_1}/${KN_1}`,
      to: `knowledge/${COURSE_1}/${KN_2}`,
      relation: "prerequisite",
      basis: "recorded",
      knowledgeStatus: "needs_check",
      evidenceRefs: [],
    });
  });

  it("deduplicates duplicate knowledge edges with priority supported > needs_check > suggested", async () => {
    const state = makeBaseState();
    state.sourceChunks = [{ id: CHUNK_1, source_id: SRC_1, source_version: 2, page: 5 }];
    state.knowledge = [
      {
        course_id: COURSE_1,
        version: 4,
        updated_at: "2026-11-18T01:00:00.000Z",
        snapshot: {
          courseId: COURSE_1,
          version: 4,
          nodes: [
            { id: KN_1, courseId: COURSE_1, label: "线性组合", kind: "concept", evidenceChunkIds: [], status: "supported" },
            { id: KN_2, courseId: COURSE_1, label: "线性相关", kind: "concept", evidenceChunkIds: [], status: "supported" },
            { id: KN_3, courseId: COURSE_1, label: "线性无关", kind: "concept", evidenceChunkIds: [], status: "supported" },
          ],
          edges: [
            // KN_1 -> KN_2: suggested + needs_check + verified supported => supported wins
            { from: KN_1, to: KN_2, kind: "prerequisite", evidenceChunkIds: [], status: "suggested" },
            { from: KN_1, to: KN_2, kind: "prerequisite", evidenceChunkIds: [], status: "needs_check" },
            { from: KN_1, to: KN_2, kind: "prerequisite", evidenceChunkIds: [CHUNK_1], status: "supported" },
            // KN_1 -> KN_3: suggested + unverified supported (downgraded to needs_check) => needs_check wins over suggested
            { from: KN_1, to: KN_3, kind: "contains", evidenceChunkIds: [], status: "suggested" },
            { from: KN_1, to: KN_3, kind: "contains", evidenceChunkIds: [CHUNK_2], status: "supported" },
          ],
        } satisfies KnowledgeSnapshot,
      },
    ];

    const { repo } = createHarness(state);
    const out = await repo.query(SCOPE, {
      op: "neighbors",
      context: { kind: "course", id: `course/${COURSE_1}` },
      lens: "structure",
      focus: `knowledge/${COURSE_1}/${KN_1}`,
      direction: "out",
        includeKnowledgeEdgeDetails: true,
    });

    expect(out.edges).toEqual([
      {
        id: `recorded:contains:knowledge/${COURSE_1}/${KN_1}:knowledge/${COURSE_1}/${KN_3}`,
        from: `knowledge/${COURSE_1}/${KN_1}`,
        to: `knowledge/${COURSE_1}/${KN_3}`,
        relation: "contains",
        basis: "recorded",
        knowledgeStatus: "needs_check",
        evidenceRefs: [],
      },
      {
        id: `recorded:prerequisite:knowledge/${COURSE_1}/${KN_1}:knowledge/${COURSE_1}/${KN_2}`,
        from: `knowledge/${COURSE_1}/${KN_1}`,
        to: `knowledge/${COURSE_1}/${KN_2}`,
        relation: "prerequisite",
        basis: "recorded",
        knowledgeStatus: "supported",
        sourceNodeId: `source/${SRC_1}`,
        sourceVersion: 2,
        page: 5,
        evidenceRefs: [{ sourceId: SRC_1, sourceVersion: 2, chunkId: CHUNK_1, page: 5 }],
      },
    ]);
  });

  it("invalidates neighbor cursors with CURSOR_STALE on source unlinking, purpose change, privacy exclusion, or graph rebuild", async () => {
    const state = makeBaseState();
    state.sourceChunks = [{ id: CHUNK_1, source_id: SRC_1, source_version: 2, page: 9 }];
    state.knowledge = [
      {
        course_id: COURSE_1,
        version: 4,
        updated_at: "2026-11-18T01:00:00.000Z",
        snapshot: {
          courseId: COURSE_1,
          version: 4,
          nodes: [
            { id: KN_1, courseId: COURSE_1, label: "线性组合", kind: "concept", evidenceChunkIds: [CHUNK_1], status: "supported" },
            { id: KN_2, courseId: COURSE_1, label: "线性相关", kind: "concept", evidenceChunkIds: [], status: "supported" },
            { id: KN_3, courseId: COURSE_1, label: "线性无关", kind: "concept", evidenceChunkIds: [], status: "supported" },
          ],
          edges: [
            { from: KN_1, to: KN_2, kind: "prerequisite", evidenceChunkIds: [CHUNK_1], status: "supported" },
            { from: KN_1, to: KN_3, kind: "contains", evidenceChunkIds: [], status: "suggested" },
          ],
        } satisfies KnowledgeSnapshot,
      },
    ];

    const { repo } = createHarness(state);
    const readPage1 = () =>
      repo.query(SCOPE, {
        op: "neighbors",
        context: { kind: "course", id: `course/${COURSE_1}` },
        lens: "structure",
        focus: `knowledge/${COURSE_1}/${KN_1}`,
        direction: "out",
        includeKnowledgeEdgeDetails: true,
        limit: 1,
      });

    // 1. Membership purpose change -> CURSOR_STALE
    const p1 = await readPage1();
    expect(p1.page.nextCursor).toBeTruthy();
    state.memberships[0]!.purpose = "reference";
    await expect(
      repo.query(SCOPE, {
        op: "neighbors",
        context: { kind: "course", id: `course/${COURSE_1}` },
        lens: "structure",
        focus: `knowledge/${COURSE_1}/${KN_1}`,
        direction: "out",
        includeKnowledgeEdgeDetails: true,
        limit: 1,
        cursor: p1.page.nextCursor!,
      }),
    ).rejects.toMatchObject({ code: "CURSOR_STALE" });

    // 2. Restore purpose, then privacy exclusion (without privacyEpoch bump) -> CURSOR_STALE
    state.memberships[0]!.purpose = "teaching";
    const p2 = await readPage1();
    expect(p2.page.nextCursor).toBeTruthy();
    state.exclusions = [{ source_id: SRC_1 }];
    state.sources[0]!.ai_excluded = true;
    await expect(
      repo.query(SCOPE, {
        op: "neighbors",
        context: { kind: "course", id: `course/${COURSE_1}` },
        lens: "structure",
        focus: `knowledge/${COURSE_1}/${KN_1}`,
        direction: "out",
        includeKnowledgeEdgeDetails: true,
        limit: 1,
        cursor: p2.page.nextCursor!,
      }),
    ).rejects.toMatchObject({ code: "CURSOR_STALE" });

    // 3. Restore privacy, then knowledge graph version rebuild -> CURSOR_STALE
    state.exclusions = [];
    state.sources[0]!.ai_excluded = false;
    const p3 = await readPage1();
    expect(p3.page.nextCursor).toBeTruthy();
    (state.knowledge[0]!.snapshot as KnowledgeSnapshot).version = 5;
    state.knowledge[0]!.version = 5;
    await expect(
      repo.query(SCOPE, {
        op: "neighbors",
        context: { kind: "course", id: `course/${COURSE_1}` },
        lens: "structure",
        focus: `knowledge/${COURSE_1}/${KN_1}`,
        direction: "out",
        includeKnowledgeEdgeDetails: true,
        limit: 1,
        cursor: p3.page.nextCursor!,
      }),
    ).rejects.toMatchObject({ code: "CURSOR_STALE" });
  });
});
