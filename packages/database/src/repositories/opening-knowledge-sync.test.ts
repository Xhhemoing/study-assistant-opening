import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { createOpeningKnowledgeRepository } from "./opening-knowledge";

const W = "00000000-0000-4000-8000-000000000001";
const U = "00000000-0000-4000-8000-000000000002";
const C = "00000000-0000-4000-8000-000000000003";
const S1 = "00000000-0000-4000-8000-000000000011";
const S2 = "00000000-0000-4000-8000-000000000012";
const N1 = "00000000-0000-4000-8000-000000000021";
const CH1 = "00000000-0000-4000-8000-000000000031";
const scope = { workspaceId: W, ownerUserId: U };

type JobRow = {
  id: string;
  workspace_id: string;
  owner_user_id: string;
  key: string;
  kind: string;
  payload: { courseId: string };
  result: Record<string, unknown> | null;
  state: string;
  privacy_epoch: number;
  created_at: Date;
  updated_at: Date;
};

type KnowledgeRow = {
  workspace_id: string;
  owner_user_id: string;
  course_id: string;
  version: number;
  snapshot: {
    courseId: string;
    version: number;
    nodes: Array<{ id: string; courseId: string; label: string; kind: "concept"; evidenceChunkIds: string[]; status: "supported" | "suggested" | "needs_check" }>;
    edges: Array<{ from: string; to: string; kind: "prerequisite"; evidenceChunkIds: string[]; status: "supported" | "suggested" | "needs_check" }>;
  };
  source_versions: Record<string, number>;
};

type SourceState = {
  id: string;
  version: number;
  uploadState: string;
  parseState: string;
  available: boolean;
  excluded: boolean;
  hasChunk: boolean;
  purpose: string | null;
};

function makeFakeSql(init?: {
  courses?: Array<{ id: string; archived: boolean }>;
  sources?: SourceState[];
  knowledgeRows?: KnowledgeRow[];
  jobs?: JobRow[];
}) {
  const courses = new Map((init?.courses ?? [{ id: C, archived: false }]).map((c) => [c.id, c]));
  const sources = new Map((init?.sources ?? []).map((s) => [s.id, { ...s }]));
  const knowledge = new Map((init?.knowledgeRows ?? []).map((k) => [k.course_id, structuredClone(k)]));
  const jobs: JobRow[] = [...(init?.jobs ?? [])];
  const outbox: Array<{ job_id: string; topic: string; payload: unknown }> = [];
  const confirmations = new Set<string>();

  const sqlFn = (async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const q = parts.join("?").replace(/\s+/g, " ").trim();

    if (q.startsWith("SELECT c.id FROM courses c JOIN workspaces w")) {
      const courseId = String(values[0]);
      const wsId = String(values[1]);
      const ownerId = String(values[2]);
      const course = courses.get(courseId);
      return course && !course.archived && wsId === W && ownerId === U ? [{ id: course.id }] : [];
    }

    if (q.startsWith("SELECT privacy_epoch FROM workspaces")) {
      return values[0] === W && values[1] === U ? [{ privacy_epoch: 0 }] : [];
    }

    if (q.startsWith("SELECT id FROM workspaces")) {
      return values[0] === W && values[1] === U ? [{ id: W }] : [];
    }

    if (q.startsWith("SELECT id FROM courses WHERE id = ? AND workspace_id = ? AND archived_at IS NULL")) {
      const course = courses.get(String(values[0]));
      return course && !course.archived && values[1] === W ? [{ id: course.id }] : [];
    }

    if (q.startsWith("SELECT version, snapshot, source_versions FROM opening_course_knowledge")) {
      const row = knowledge.get(String(values[2]));
      return row ? [row] : [];
    }

    if (q.startsWith("SELECT workspace_id, course_id, version, snapshot, source_versions FROM opening_course_knowledge")) {
      if (values.length === 3) {
        const row = knowledge.get(String(values[2]));
        return row ? [row] : [];
      }
      return [...knowledge.values()];
    }

    if (q.startsWith("DELETE FROM opening_knowledge_confirmations")) {
      confirmations.delete(String(values[2]));
      return [];
    }

    if (q.startsWith("UPDATE opening_course_knowledge SET version = ?")) {
      const version = Number(values[0]);
      const snapshot = values[1] as KnowledgeRow["snapshot"];
      const courseId = String(values[3]);
      const row = knowledge.get(courseId);
      if (row && row.version === Number(values[4])) {
        row.version = version;
        row.snapshot = snapshot;
      }
      return [];
    }

    if (q.startsWith("SELECT s.id, s.version FROM opening_sources s")) {
      return [...sources.values()]
        .filter(
          (s) =>
            (s.purpose === null || s.purpose === "teaching")
            && s.uploadState === "uploaded"
            && s.parseState === "ready"
            && s.available
            && !s.excluded
            && s.hasChunk,
        )
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((s) => ({ id: s.id, version: s.version }));
    }

    if (q.startsWith("SELECT count(*)::int AS count FROM opening_sources s")) {
      const count = [...sources.values()].filter(
        (s) =>
          (s.purpose === null || s.purpose === "teaching")
          && !s.excluded
          && (s.uploadState === "pending" || s.uploadState === "uploaded")
          && (s.parseState === "not_started" || s.parseState === "queued" || s.parseState === "running"),
      ).length;
      return [{ count }];
    }

    if (q.startsWith("SELECT m.asset_id AS source_id, s.version")) {
      return [...sources.values()]
        .filter((s) => s.purpose === null || s.purpose === "teaching")
        .map((s) => ({ source_id: s.id, version: s.version, excluded: s.excluded }));
    }

    if (q.startsWith("SELECT id FROM course_asset_memberships")) {
      const ids = values[2] as string[];
      const hasRestricted = ids.some((id) => {
        const s = sources.get(id);
        return s && (s.purpose === "practice" || s.purpose === "reference" || s.purpose === "mock_exam");
      });
      return hasRestricted ? [{ id: "restricted" }] : [];
    }

    if (q.startsWith("SELECT id FROM opening_jobs") && q.includes("state IN ('queued', 'running')")) {
      const courseId = String(values[2]);
      const matching = jobs
        .filter((j) => j.kind === "build-course-knowledge" && j.payload.courseId === courseId && (j.state === "queued" || j.state === "running"))
        .sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime() || b.created_at.getTime() - a.created_at.getTime() || b.id.localeCompare(a.id));
      return matching.length ? [{ id: matching[0]!.id }] : [];
    }

    if (q.startsWith("SELECT id, result FROM opening_jobs") && q.includes("state = 'succeeded'")) {
      const courseId = String(values[2]);
      const matching = jobs
        .filter((j) => j.kind === "build-course-knowledge" && j.payload.courseId === courseId && j.state === "succeeded")
        .sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime() || b.created_at.getTime() - a.created_at.getTime() || b.id.localeCompare(a.id));
      return matching.length ? [{ id: matching[0]!.id, result: matching[0]!.result }] : [];
    }

    if (q.startsWith("SELECT id FROM opening_jobs") && q.includes("state = 'queued'")) {
      const courseId = String(values[2]);
      const matching = jobs
        .filter((j) => j.kind === "build-course-knowledge" && j.payload.courseId === courseId && j.state === "queued")
        .sort((a, b) => b.created_at.getTime() - a.created_at.getTime() || b.id.localeCompare(a.id));
      return matching.length ? [{ id: matching[0]!.id }] : [];
    }

    if (q.startsWith("SELECT id FROM opening_jobs") && q.includes("state = 'running'")) {
      const courseId = String(values[2]);
      const matching = jobs
        .filter((j) => j.kind === "build-course-knowledge" && j.payload.courseId === courseId && j.state === "running")
        .sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime() || b.created_at.getTime() - a.created_at.getTime() || b.id.localeCompare(a.id));
      return matching.length ? [{ id: matching[0]!.id }] : [];
    }

    if (q.startsWith("INSERT INTO opening_jobs")) {
      const [id, workspaceId, ownerUserId, key, kind, payload, privacyEpoch] = values as [
        string,
        string,
        string,
        string,
        string,
        { courseId: string },
        number,
      ];
      if (jobs.some((j) => j.workspace_id === workspaceId && j.key === key)) {
        return [];
      }
      const now = new Date();
      jobs.push({
        id,
        workspace_id: workspaceId,
        owner_user_id: ownerUserId,
        key,
        kind,
        payload,
        result: null,
        state: "queued",
        privacy_epoch: privacyEpoch,
        created_at: now,
        updated_at: now,
      });
      return [{ id }];
    }

    if (q.startsWith("SELECT id, state, payload FROM opening_jobs")) {
      const [workspaceId, key] = values as [string, string];
      const row = jobs.find((j) => j.workspace_id === workspaceId && j.key === key);
      return row ? [{ id: row.id, state: row.state, payload: row.payload }] : [];
    }

    if (q.startsWith("INSERT INTO opening_outbox")) {
      const [, jobId, topic, payload] = values;
      outbox.push({ job_id: String(jobId), topic: String(topic), payload });
      return [];
    }

    if (q.startsWith("SELECT DISTINCT c.id AS course_id FROM courses c")) {
      const sourceId = String(values[2]);
      const matching: Array<{ course_id: string }> = [];
      for (const course of courses.values()) {
        if (course.archived) continue;
        const s = sources.get(sourceId);
        const inMembership = Boolean(s && (s.purpose === null || s.purpose === "teaching"));
        const inKnowledge = Boolean(knowledge.get(course.id)?.source_versions[sourceId] !== undefined);
        const inCovered = jobs.some(
          (j) =>
            j.kind === "build-course-knowledge"
            && j.state === "succeeded"
            && j.payload.courseId === course.id
            && typeof (j.result?.coveredSourceVersions as Record<string, unknown> | undefined)?.[sourceId] === "number",
        );
        if (inMembership || inKnowledge || inCovered) {
          matching.push({ course_id: course.id });
        }
      }
      return matching.sort((a, b) => a.course_id.localeCompare(b.course_id));
    }

    throw new Error(`Unexpected SQL in sync unit test: ${q}`);
  }) as unknown as Sql;

  (sqlFn as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
  (sqlFn as unknown as { begin: <T>(cb: (tx: Sql) => Promise<T>) => Promise<T> }).begin = (cb) => cb(sqlFn);

  return { sql: sqlFn, jobs, outbox, knowledge, sources };
}

function knowledgeRow(overrides: Partial<KnowledgeRow> = {}): KnowledgeRow {
  return {
    workspace_id: W,
    owner_user_id: U,
    course_id: C,
    version: 1,
    snapshot: {
      courseId: C,
      version: 1,
      nodes: [{ id: N1, courseId: C, label: "极限", kind: "concept", evidenceChunkIds: [CH1], status: "supported" }],
      edges: [],
    },
    source_versions: { [S1]: 1 },
    ...overrides,
  };
}

describe("opening knowledge sync and coalescing", () => {
  it("reports empty status with parsingSourceCount when materials are still parsing", async () => {
    const db = makeFakeSql({
      sources: [{ id: S1, version: 0, uploadState: "uploaded", parseState: "queued", available: true, excluded: false, hasChunk: false, purpose: "teaching" }],
    });
    const repo = createOpeningKnowledgeRepository(db.sql);
    await expect(repo.readSyncStatus(scope, C)).resolves.toEqual({
      status: "empty",
      activeJobId: null,
      lastBuiltVersion: null,
      coveredSourceVersions: {},
      eligibleSourceVersions: {},
      parsingSourceCount: 1,
    });
    await expect(repo.getWithSync(scope, C)).resolves.toEqual({
      version: 0,
      snapshot: { courseId: C, version: 0, nodes: [], edges: [] },
      sourceVersions: {},
      sync: {
        status: "empty",
        activeJobId: null,
        lastBuiltVersion: null,
        coveredSourceVersions: {},
        eligibleSourceVersions: {},
        parsingSourceCount: 1,
      },
    });
  });

  it("reads lastBuiltVersion and coveredSourceVersions from latest succeeded job instead of confirmNode version", async () => {
    const jobId = randomUUID();
    const db = makeFakeSql({
      sources: [
        { id: S1, version: 1, uploadState: "uploaded", parseState: "ready", available: true, excluded: false, hasChunk: true, purpose: "teaching" },
        { id: S2, version: 2, uploadState: "uploaded", parseState: "ready", available: true, excluded: false, hasChunk: true, purpose: "teaching" },
      ],
      knowledgeRows: [knowledgeRow({ version: 4, source_versions: { [S1]: 1 } })],
      jobs: [{
        id: jobId,
        workspace_id: W,
        owner_user_id: U,
        key: "k1",
        kind: "build-course-knowledge",
        payload: { courseId: C },
        result: { version: 2, coveredSourceVersions: { [S1]: 1, [S2]: 2 } },
        state: "succeeded",
        privacy_epoch: 0,
        created_at: new Date(1),
        updated_at: new Date(2),
      }],
    });
    const repo = createOpeningKnowledgeRepository(db.sql);
    const sync = await repo.readSyncStatus(scope, C);
    expect(sync).toEqual({
      status: "up_to_date",
      activeJobId: null,
      lastBuiltVersion: 2,
      coveredSourceVersions: { [S1]: 1, [S2]: 2 },
      eligibleSourceVersions: { [S1]: 1, [S2]: 2 },
      parsingSourceCount: 0,
    });
  });

  it("hides restricted nodes and sourceVersions in getWithSync while preserving version and sync", async () => {
    const db = makeFakeSql({
      sources: [{ id: S1, version: 1, uploadState: "uploaded", parseState: "ready", available: true, excluded: false, hasChunk: true, purpose: "mock_exam" }],
      knowledgeRows: [knowledgeRow({ version: 5, source_versions: { [S1]: 1 } })],
    });
    const repo = createOpeningKnowledgeRepository(db.sql);
    const result = await repo.getWithSync(scope, C);
    expect(result.version).toBe(5);
    expect(result.snapshot).toEqual({ courseId: C, version: 5, nodes: [], edges: [] });
    expect(result.sourceVersions).toEqual({});
    expect(result.sync?.status).toBe("needs_rebuild");
  });

  it("coalesces bursts onto a queued job while allowing one queued follow-up alongside a running job", async () => {
    const runningId = randomUUID();
    const db = makeFakeSql({
      jobs: [{
        id: runningId,
        workspace_id: W,
        owner_user_id: U,
        key: "running-1",
        kind: "build-course-knowledge",
        payload: { courseId: C },
        result: null,
        state: "running",
        privacy_epoch: 0,
        created_at: new Date(1),
        updated_at: new Date(1),
      }],
    });
    const repo = createOpeningKnowledgeRepository(db.sql);
    const queued = await repo.enqueueCoalescedRebuild(scope, C, "hash-a");
    expect(queued.created).toBe(true);
    expect(db.jobs).toHaveLength(2);
    expect(db.jobs[1]).toMatchObject({
      key: `build-course-knowledge:${C}:sync:hash-a:${runningId}`,
      payload: { courseId: C },
      state: "queued",
    });
    expect(db.outbox).toHaveLength(1);
    expect(db.outbox[0]).toMatchObject({
      job_id: queued.jobId,
      topic: "opening.job.enqueue",
      payload: { jobId: queued.jobId, kind: "build-course-knowledge", courseId: C },
    });

    const coalesced = await repo.enqueueCoalescedRebuild(scope, C, "hash-b");
    expect(coalesced).toEqual({ jobId: queued.jobId, kind: "build-course-knowledge", created: false });
    expect(db.jobs).toHaveLength(2);
    expect(db.outbox).toHaveLength(1);
  });

  it("reconcileCourseMaterials skips needs_check when adding a second source and marks needs_check on invalidated source", async () => {
    const db = makeFakeSql({
      sources: [
        { id: S1, version: 1, uploadState: "uploaded", parseState: "ready", available: true, excluded: false, hasChunk: true, purpose: "teaching" },
        { id: S2, version: 1, uploadState: "uploaded", parseState: "ready", available: true, excluded: false, hasChunk: true, purpose: "teaching" },
      ],
      knowledgeRows: [knowledgeRow({ version: 1, source_versions: { [S1]: 1 } })],
    });
    const repo = createOpeningKnowledgeRepository(db.sql);
    const added = await repo.reconcileCourseMaterials(scope, C);
    expect(added.enqueued?.created).toBe(true);
    expect(db.knowledge.get(C)!.snapshot.nodes[0]!.status).toBe("supported");

    // Now simulate S1 being replaced / invalidated while S2 remains
    db.sources.delete(S1);
    db.jobs[0]!.state = "succeeded";
    db.jobs[0]!.result = { version: 2, coveredSourceVersions: { [S1]: 1, [S2]: 1 } };
    const replaced = await repo.reconcileCourseMaterials(scope, C, { invalidatedSourceIds: [S1] });
    expect(replaced.enqueued?.created).toBe(true);
    expect(db.knowledge.get(C)!.snapshot.nodes[0]!.status).toBe("needs_check");
  });

  it("reconcileCoursesForSource ignores archived courses and finds deleted-source courses via coveredSourceVersions", async () => {
    const archivedCourseId = "00000000-0000-4000-8000-000000000099";
    const db = makeFakeSql({
      courses: [
        { id: C, archived: false },
        { id: archivedCourseId, archived: true },
      ],
      sources: [],
      knowledgeRows: [knowledgeRow({ version: 2, source_versions: {} })],
      jobs: [{
        id: randomUUID(),
        workspace_id: W,
        owner_user_id: U,
        key: "prev",
        kind: "build-course-knowledge",
        payload: { courseId: C },
        result: { version: 2, coveredSourceVersions: { [S1]: 1 } },
        state: "succeeded",
        privacy_epoch: 0,
        created_at: new Date(1),
        updated_at: new Date(2),
      }],
    });
    const repo = createOpeningKnowledgeRepository(db.sql);
    const res = await repo.reconcileCoursesForSource(scope, { sourceId: S1, markInvalidated: true });
    expect(res.courseIds).toEqual([C]);
    expect(res.results[0]?.enqueued?.created).toBe(true);
  });
});
