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
  hasTextChunk?: boolean;
  attached?: boolean;
  purpose: string | null;
};

type ChunkState = {
  id: string;
  sourceId: string;
  sourceVersion: number;
  text: string;
};

function makeFakeSql(init?: {
  courses?: Array<{ id: string; archived: boolean }>;
  sources?: SourceState[];
  chunks?: ChunkState[];
  knowledgeRows?: KnowledgeRow[];
  jobs?: JobRow[];
  onQuery?: (query: string) => void;
}) {
  const courses = new Map((init?.courses ?? [{ id: C, archived: false }]).map((c) => [c.id, c]));
  const sources = new Map((init?.sources ?? []).map((s) => [s.id, { ...s }]));
  const chunks = new Map((init?.chunks ?? []).map((c) => [c.id, { ...c }]));
  const knowledge = new Map((init?.knowledgeRows ?? []).map((k) => [k.course_id, structuredClone(k)]));
  const jobs: JobRow[] = [...(init?.jobs ?? [])];
  const outbox: Array<{ job_id: string; topic: string; payload: unknown }> = [];
  const confirmations = new Set<string>();
  const transactions: Array<{ statements: string[]; repeatableReadOnly: boolean }> = [];

  type DbView = {
    courses: Map<string, { id: string; archived: boolean }>;
    sources: Map<string, SourceState>;
    chunks: Map<string, ChunkState>;
    knowledge: Map<string, KnowledgeRow>;
    jobs: JobRow[];
  };

  function makeExecutor(txRecord?: { statements: string[]; repeatableReadOnly: boolean }): Sql {
    let view: DbView = { courses, sources, chunks, knowledge, jobs };

    const exec = ((parts: TemplateStringsArray, ...values: unknown[]) => {
      if (!Array.isArray(parts) || !("raw" in parts)) {
        return parts;
      }
      return (async () => {
      const q = parts.join("?").replace(/\s+/g, " ").trim();
      txRecord?.statements.push(q);

      if (q === "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY") {
        if (!txRecord || txRecord.statements.length !== 1) {
          throw new Error("SET TRANSACTION must be the first statement inside a transaction");
        }
        txRecord.repeatableReadOnly = true;
        view = {
          courses: new Map([...courses.entries()].map(([k, v]) => [k, { ...v }])),
          sources: new Map([...sources.entries()].map(([k, v]) => [k, { ...v }])),
          chunks: new Map([...chunks.entries()].map(([k, v]) => [k, { ...v }])),
          knowledge: new Map([...knowledge.entries()].map(([k, v]) => [k, structuredClone(v)])),
          jobs: jobs.map((j) => ({
            ...j,
            payload: { ...j.payload },
            result: j.result ? structuredClone(j.result) : null,
            created_at: new Date(j.created_at.getTime()),
            updated_at: new Date(j.updated_at.getTime()),
          })),
        };
        init?.onQuery?.(q);
        return [];
      }

      if (q.startsWith("SELECT c.id FROM courses c JOIN workspaces w")) {
        const courseId = String(values[0]);
        const wsId = String(values[1]);
        const ownerId = String(values[2]);
        const course = view.courses.get(courseId);
        init?.onQuery?.(q);
        return course && !course.archived && wsId === W && ownerId === U ? [{ id: course.id }] : [];
      }

      if (q.startsWith("SELECT w.id FROM workspaces w JOIN courses c")) {
        const courseId = String(values[0]);
        const wsId = String(values[1]);
        const ownerId = String(values[2]);
        const course = view.courses.get(courseId);
        init?.onQuery?.(q);
        return course && !course.archived && wsId === W && ownerId === U ? [{ id: W }] : [];
      }

      if (q.startsWith("SELECT privacy_epoch FROM workspaces")) {
        init?.onQuery?.(q);
        return values[0] === W && values[1] === U ? [{ privacy_epoch: 0 }] : [];
      }

      if (q.startsWith("SELECT id FROM workspaces")) {
        init?.onQuery?.(q);
        return values[0] === W && values[1] === U ? [{ id: W }] : [];
      }

      if (q.startsWith("SELECT id FROM courses WHERE id = ? AND workspace_id = ? AND archived_at IS NULL")) {
        const course = view.courses.get(String(values[0]));
        init?.onQuery?.(q);
        return course && !course.archived && values[1] === W ? [{ id: course.id }] : [];
      }

      if (q.startsWith("SELECT version, snapshot, source_versions, node_definitions FROM opening_course_knowledge")) {
        const row = view.knowledge.get(String(values[1]));
        init?.onQuery?.(q);
        return row ? [{ ...row, node_definitions: {} }] : [];
      }

      if (q.startsWith("SELECT version, snapshot, source_versions FROM opening_course_knowledge")) {
        const row = view.knowledge.get(String(values[2]));
        init?.onQuery?.(q);
        return row ? [row] : [];
      }

      if (q.startsWith("SELECT workspace_id, course_id, version, snapshot, source_versions FROM opening_course_knowledge")) {
        init?.onQuery?.(q);
        if (values.length === 3) {
          const row = view.knowledge.get(String(values[2]));
          return row ? [row] : [];
        }
        return [...view.knowledge.values()];
      }

      if (q.startsWith("DELETE FROM opening_knowledge_confirmations")) {
        confirmations.delete(String(values[2]));
        init?.onQuery?.(q);
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
        init?.onQuery?.(q);
        return [];
      }

      if (q.startsWith("SELECT c.* FROM opening_source_chunks c")) {
        const chunkIds = values[2] as string[];
        const found = chunkIds
          .map((id) => view.chunks.get(id))
          .filter((chunk): chunk is ChunkState => {
            if (!chunk) return false;
            const s = view.sources.get(chunk.sourceId);
            return Boolean(
              s
                && s.attached !== false
                && (s.purpose === null || s.purpose === "teaching")
                && s.uploadState === "uploaded"
                && s.parseState === "ready"
                && s.available
                && !s.excluded
                && s.version === chunk.sourceVersion,
            );
          })
          .map((chunk) => ({
            id: chunk.id,
            source_id: chunk.sourceId,
            source_version: chunk.sourceVersion,
            page: 1,
            text: chunk.text,
            image_object_key: null,
            created_at: new Date(1),
          }));
        init?.onQuery?.(q);
        return found;
      }

      if (q.startsWith("SELECT node_id FROM opening_skill_evidence")) {
        init?.onQuery?.(q);
        return [];
      }

      if (q.startsWith("SELECT DISTINCT ON (node_id) node_id,node_label,node_kind,source_versions,evidence_chunk_ids")) {
        init?.onQuery?.(q);
        return [];
      }

      if (q.startsWith("INSERT INTO opening_course_knowledge")) {
        const [wsId, ownerId, courseId, newVersion, snapshot, sourceVersions, , expectedVersion] = values as [
          string,
          string,
          string,
          number,
          KnowledgeRow["snapshot"],
          Record<string, number>,
          unknown,
          number,
        ];
        const existing = knowledge.get(courseId);
        if (existing && existing.version !== expectedVersion) {
          init?.onQuery?.(q);
          return [];
        }
        const stored: KnowledgeRow = {
          workspace_id: wsId,
          owner_user_id: ownerId,
          course_id: courseId,
          version: newVersion,
          snapshot: structuredClone(snapshot),
          source_versions: { ...sourceVersions },
        };
        knowledge.set(courseId, stored);
        init?.onQuery?.(q);
        return [stored];
      }

      if (q.startsWith("SELECT s.id, s.version FROM opening_sources s")) {
        init?.onQuery?.(q);
        return [...view.sources.values()]
          .filter(
            (s) =>
              s.attached !== false
              && (s.purpose === null || s.purpose === "teaching")
              && s.uploadState === "uploaded"
              && s.parseState === "ready"
              && s.available
              && !s.excluded
              && (s.hasTextChunk ?? s.hasChunk),
          )
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((s) => ({ id: s.id, version: s.version }));
      }

      if (q.startsWith("SELECT count(DISTINCT s.id)::int AS count FROM opening_sources s") && q.includes("s.parse_state = 'failed'")) {
        init?.onQuery?.(q);
        const count = [...view.sources.values()].filter(
          (s) =>
            s.attached !== false
            && (s.purpose === null || s.purpose === "teaching")
            && s.uploadState === "uploaded"
            && s.available
            && !s.excluded
            && (s.parseState === "failed" || (s.parseState === "ready" && !(s.hasTextChunk ?? s.hasChunk))),
        ).length;
        return [{ count }];
      }

      if (q.startsWith("SELECT count(DISTINCT s.id)::int AS count FROM opening_sources s") || q.startsWith("SELECT count(*)::int AS count FROM opening_sources s")) {
        init?.onQuery?.(q);
        const count = [...view.sources.values()].filter(
          (s) =>
            s.attached !== false
            && (s.purpose === null || s.purpose === "teaching")
            && !s.excluded
            && (s.uploadState === "pending" || s.uploadState === "uploaded")
            && (s.parseState === "not_started" || s.parseState === "queued" || s.parseState === "running"),
        ).length;
        return [{ count }];
      }

      if (q.startsWith("SELECT src.id AS source_id,")) {
        init?.onQuery?.(q);
        const ids = values[4] as string[];
        return ids.map((id) => {
          const s = view.sources.get(id);
          return {
            source_id: id,
            source_exists: Boolean(s),
            excluded: Boolean(s?.excluded),
            restricted_purpose: Boolean(
              s
                && s.attached !== false
                && (s.purpose === "practice" || s.purpose === "reference" || s.purpose === "mock_exam"),
            ),
          };
        });
      }

      if (q.startsWith("SELECT m.asset_id AS source_id, s.version")) {
        init?.onQuery?.(q);
        return [...view.sources.values()]
          .filter((s) => s.attached !== false && (s.purpose === null || s.purpose === "teaching"))
          .map((s) => ({ source_id: s.id, version: s.version, excluded: s.excluded }));
      }

      if (q.startsWith("SELECT id FROM course_asset_memberships")) {
        init?.onQuery?.(q);
        const ids = values[2] as string[];
        const hasRestricted = ids.some((id) => {
          const s = view.sources.get(id);
          return s && s.attached !== false && (s.purpose === "practice" || s.purpose === "reference" || s.purpose === "mock_exam");
        });
        return hasRestricted ? [{ id: "restricted" }] : [];
      }

      if (q.startsWith("SELECT id, state FROM opening_jobs") && q.includes("WHERE id = ?")) {
        init?.onQuery?.(q);
        const [jobId, wsId, ownerId, courseId] = values as [string, string, string, string];
        const row = view.jobs.find(
          (j) =>
            j.id === jobId
            && j.workspace_id === wsId
            && j.owner_user_id === ownerId
            && j.kind === "build-course-knowledge"
            && j.payload.courseId === courseId,
        );
        return row ? [{ id: row.id, state: row.state }] : [];
      }

      if (q.startsWith("SELECT id, state FROM opening_jobs") && q.includes("state IN ('succeeded', 'failed', 'outcome_unknown', 'cancelled')")) {
        init?.onQuery?.(q);
        const [wsId, ownerId, courseId] = values as [string, string, string];
        const matching = view.jobs
          .filter(
            (j) =>
              j.workspace_id === wsId
              && j.owner_user_id === ownerId
              && j.kind === "build-course-knowledge"
              && j.payload.courseId === courseId
              && (j.state === "succeeded" || j.state === "failed" || j.state === "outcome_unknown" || j.state === "cancelled"),
          )
          .sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime() || b.created_at.getTime() - a.created_at.getTime() || b.id.localeCompare(a.id));
        return matching.length ? [{ id: matching[0]!.id, state: matching[0]!.state }] : [];
      }

      if (q.startsWith("SELECT id FROM opening_jobs") && q.includes("state IN ('queued', 'running')")) {
        init?.onQuery?.(q);
        const courseId = String(values[2]);
        const matching = view.jobs
          .filter((j) => j.kind === "build-course-knowledge" && j.payload.courseId === courseId && (j.state === "queued" || j.state === "running"))
          .sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime() || b.created_at.getTime() - a.created_at.getTime() || b.id.localeCompare(a.id));
        return matching.length ? [{ id: matching[0]!.id }] : [];
      }

      if (q.startsWith("SELECT id, result FROM opening_jobs") && q.includes("state = 'succeeded'")) {
        init?.onQuery?.(q);
        const courseId = String(values[2]);
        const matching = view.jobs
          .filter((j) => j.kind === "build-course-knowledge" && j.payload.courseId === courseId && j.state === "succeeded")
          .sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime() || b.created_at.getTime() - a.created_at.getTime() || b.id.localeCompare(a.id));
        return matching.length ? [{ id: matching[0]!.id, result: matching[0]!.result }] : [];
      }

      if (q.startsWith("SELECT id FROM opening_jobs") && q.includes("state = 'queued'")) {
        init?.onQuery?.(q);
        const courseId = String(values[2]);
        const matching = view.jobs
          .filter((j) => j.kind === "build-course-knowledge" && j.payload.courseId === courseId && j.state === "queued")
          .sort((a, b) => b.created_at.getTime() - a.created_at.getTime() || b.id.localeCompare(a.id));
        return matching.length ? [{ id: matching[0]!.id }] : [];
      }

      if (q.startsWith("SELECT id FROM opening_jobs") && q.includes("state = 'running'")) {
        init?.onQuery?.(q);
        const courseId = String(values[2]);
        const matching = view.jobs
          .filter((j) => j.kind === "build-course-knowledge" && j.payload.courseId === courseId && j.state === "running")
          .sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime() || b.created_at.getTime() - a.created_at.getTime() || b.id.localeCompare(a.id));
        return matching.length ? [{ id: matching[0]!.id }] : [];
      }

      if (q.startsWith("INSERT INTO opening_jobs")) {
        init?.onQuery?.(q);
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

      if (q.startsWith("SELECT id, payload FROM opening_jobs")) {
        init?.onQuery?.(q);
        const [workspaceId, key] = values as [string, string];
        const row = view.jobs.find((j) => j.workspace_id === workspaceId && j.key === key);
        return row ? [{ id: row.id, payload: row.payload }] : [];
      }

      if (q.startsWith("SELECT id, state, payload FROM opening_jobs")) {
        init?.onQuery?.(q);
        const [workspaceId, key] = values as [string, string];
        const row = view.jobs.find((j) => j.workspace_id === workspaceId && j.key === key);
        return row ? [{ id: row.id, state: row.state, payload: row.payload }] : [];
      }

      if (q.startsWith("INSERT INTO opening_outbox")) {
        init?.onQuery?.(q);
        const [, jobId, topic, payload] = values;
        outbox.push({ job_id: String(jobId), topic: String(topic), payload });
        return [];
      }

      if (q.startsWith("SELECT DISTINCT c.id AS course_id FROM courses c")) {
        init?.onQuery?.(q);
        const sourceId = String(values[2]);
        const matching: Array<{ course_id: string }> = [];
        for (const course of view.courses.values()) {
          if (course.archived) continue;
          const s = view.sources.get(sourceId);
          const inMembership = Boolean(s && s.attached !== false && (s.purpose === null || s.purpose === "teaching"));
          const inKnowledge = Boolean(view.knowledge.get(course.id)?.source_versions[sourceId] !== undefined);
          const inCovered = view.jobs.some(
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
      })();
    }) as unknown as Sql;

    (exec as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
    (exec as unknown as { begin: <T>(cb: (tx: Sql) => Promise<T>) => Promise<T> }).begin = async (cb) => {
      const record = { statements: [] as string[], repeatableReadOnly: false };
      transactions.push(record);
      return cb(makeExecutor(record));
    };
    return exec;
  }

  const sqlFn = makeExecutor();
  return { sql: sqlFn, jobs, outbox, knowledge, sources, chunks, transactions };
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

  it("D1+D6: returns exact 6 fields by default and detailed 10 fields with unreadableSourceCount on includeDetails", async () => {
    const sFailed = "00000000-0000-4000-8000-000000000013";
    const sImageOnly = "00000000-0000-4000-8000-000000000014";
    const sQueued = "00000000-0000-4000-8000-000000000015";
    const db = makeFakeSql({
      sources: [
        { id: sFailed, version: 1, uploadState: "uploaded", parseState: "failed", available: true, excluded: false, hasChunk: false, purpose: "teaching" },
        { id: sImageOnly, version: 1, uploadState: "uploaded", parseState: "ready", available: true, excluded: false, hasChunk: true, hasTextChunk: false, purpose: "teaching" },
        { id: sQueued, version: 1, uploadState: "uploaded", parseState: "queued", available: true, excluded: false, hasChunk: false, purpose: "teaching" },
      ],
    });
    const repo = createOpeningKnowledgeRepository(db.sql);

    const legacySync = await repo.readSyncStatus(scope, C);
    expect(Object.keys(legacySync).sort()).toEqual([
      "activeJobId",
      "coveredSourceVersions",
      "eligibleSourceVersions",
      "lastBuiltVersion",
      "parsingSourceCount",
      "status",
    ]);
    expect(legacySync).toEqual({
      status: "empty",
      activeJobId: null,
      lastBuiltVersion: null,
      coveredSourceVersions: {},
      eligibleSourceVersions: {},
      parsingSourceCount: 1,
    });

    const detailed = await repo.readSyncStatus(scope, C, { includeDetails: true });
    expect(detailed).toEqual({
      ...legacySync,
      unreadableSourceCount: 2,
      rebuildBlockedByMaterials: false,
      lastFailedJob: null,
      requestedJob: null,
    });

    // Mixed image+text recovery moves the source out of unreadable and into eligible
    db.sources.get(sImageOnly)!.hasTextChunk = true;
    const afterRecovery = await repo.readSyncStatus(scope, C, { includeDetails: true });
    expect(afterRecovery.unreadableSourceCount).toBe(1);
    expect(afterRecovery.eligibleSourceVersions).toEqual({ [sImageOnly]: 1 });
    expect(afterRecovery.status).toBe("needs_rebuild");
  });

  it("D2+D6: reports latest terminal failure in lastFailedJob (cleared by later success) and isolates requestedJob by scope/course/kind", async () => {
    const jFailed = randomUUID();
    const jSucceeded = randomUUID();
    const jOtherCourse = randomUUID();
    const jOtherKind = randomUUID();
    const jOtherOwner = randomUUID();
    const db = makeFakeSql({
      sources: [{ id: S1, version: 1, uploadState: "uploaded", parseState: "ready", available: true, excluded: false, hasChunk: true, purpose: "teaching" }],
      jobs: [
        {
          id: jFailed,
          workspace_id: W,
          owner_user_id: U,
          key: "k-failed",
          kind: "build-course-knowledge",
          payload: { courseId: C },
          result: { error: "internal stack trace must never leak" },
          state: "outcome_unknown",
          privacy_epoch: 0,
          created_at: new Date(10),
          updated_at: new Date(20),
        },
        {
          id: jOtherCourse,
          workspace_id: W,
          owner_user_id: U,
          key: "k-other-course",
          kind: "build-course-knowledge",
          payload: { courseId: "00000000-0000-4000-8000-000000000099" },
          result: null,
          state: "failed",
          privacy_epoch: 0,
          created_at: new Date(30),
          updated_at: new Date(30),
        },
        {
          id: jOtherKind,
          workspace_id: W,
          owner_user_id: U,
          key: "k-other-kind",
          kind: "parse",
          payload: { courseId: C },
          result: null,
          state: "failed",
          privacy_epoch: 0,
          created_at: new Date(30),
          updated_at: new Date(30),
        },
        {
          id: jOtherOwner,
          workspace_id: W,
          owner_user_id: "00000000-0000-4000-8000-000000000098",
          key: "k-other-owner",
          kind: "build-course-knowledge",
          payload: { courseId: C },
          result: null,
          state: "failed",
          privacy_epoch: 0,
          created_at: new Date(30),
          updated_at: new Date(30),
        },
      ],
    });
    const repo = createOpeningKnowledgeRepository(db.sql);

    const withFailure = await repo.readSyncStatus(scope, C, { includeDetails: true, requestedJobId: jFailed });
    expect(withFailure.lastFailedJob).toEqual({ jobId: jFailed, state: "outcome_unknown" });
    expect(withFailure.requestedJob).toEqual({ jobId: jFailed, state: "outcome_unknown" });
    expect("error" in (withFailure.lastFailedJob ?? {})).toBe(false);

    // Cross-course, cross-kind, cross-owner, and missing requestedJobId all return null
    expect((await repo.readSyncStatus(scope, C, { includeDetails: true, requestedJobId: jOtherCourse })).requestedJob).toBeNull();
    expect((await repo.readSyncStatus(scope, C, { includeDetails: true, requestedJobId: jOtherKind })).requestedJob).toBeNull();
    expect((await repo.readSyncStatus(scope, C, { includeDetails: true, requestedJobId: jOtherOwner })).requestedJob).toBeNull();
    expect((await repo.readSyncStatus(scope, C, { includeDetails: true, requestedJobId: randomUUID() })).requestedJob).toBeNull();

    // Subsequent succeeded job clears lastFailedJob while still reporting requestedJob for jFailed
    db.jobs.push({
      id: jSucceeded,
      workspace_id: W,
      owner_user_id: U,
      key: "k-succeeded",
      kind: "build-course-knowledge",
      payload: { courseId: C },
      result: { version: 1, coveredSourceVersions: { [S1]: 1 } },
      state: "succeeded",
      privacy_epoch: 0,
      created_at: new Date(40),
      updated_at: new Date(50),
    });
    const afterSuccess = await repo.readSyncStatus(scope, C, { includeDetails: true, requestedJobId: jFailed });
    expect(afterSuccess.lastFailedJob).toBeNull();
    expect(afterSuccess.requestedJob).toEqual({ jobId: jFailed, state: "outcome_unknown" });
  });

  it("D3: treats C=E={S1,S2} with G={S1} and needs_check nodes as up_to_date without enqueueing on repeated reconciles", async () => {
    const db = makeFakeSql({
      sources: [
        { id: S1, version: 1, uploadState: "uploaded", parseState: "ready", available: true, excluded: false, hasChunk: true, purpose: "teaching" },
        { id: S2, version: 1, uploadState: "uploaded", parseState: "ready", available: true, excluded: false, hasChunk: true, purpose: "teaching" },
      ],
      knowledgeRows: [
        knowledgeRow({
          version: 2,
          snapshot: {
            courseId: C,
            version: 2,
            nodes: [{ id: N1, courseId: C, label: "极限", kind: "concept", evidenceChunkIds: [CH1], status: "needs_check" }],
            edges: [],
          },
          source_versions: { [S1]: 1 },
        }),
      ],
      jobs: [{
        id: randomUUID(),
        workspace_id: W,
        owner_user_id: U,
        key: "k-d3",
        kind: "build-course-knowledge",
        payload: { courseId: C },
        result: { version: 2, coveredSourceVersions: { [S1]: 1, [S2]: 1 } },
        state: "succeeded",
        privacy_epoch: 0,
        created_at: new Date(1),
        updated_at: new Date(2),
      }],
    });
    const repo = createOpeningKnowledgeRepository(db.sql);
    const sync = await repo.readSyncStatus(scope, C, { includeDetails: true });
    expect(sync.status).toBe("up_to_date");
    const first = await repo.reconcileCourseMaterials(scope, C);
    const second = await repo.reconcileCourseMaterials(scope, C);
    expect(first.enqueued).toBeNull();
    expect(second.enqueued).toBeNull();
    expect(db.jobs).toHaveLength(1);
  });

  it("D4: blocks auto reconcile, new manual POST (409), and destructive replace when old evidence is lost while replacement is unreadable or recovered after extraction, while allowing same-key replay and mandatory cleanup", async () => {
    const existingReceiptId = randomUUID();
    const sBad = "00000000-0000-4000-8000-000000000016";
    const db = makeFakeSql({
      sources: [
        // S1 was unlinked (still exists, not excluded, not restricted) and replaced by sBad (failed parse)
        { id: S1, version: 1, uploadState: "uploaded", parseState: "ready", available: true, excluded: false, hasChunk: true, attached: false, purpose: "teaching" },
        { id: sBad, version: 1, uploadState: "uploaded", parseState: "failed", available: true, excluded: false, hasChunk: false, attached: true, purpose: "teaching" },
      ],
      knowledgeRows: [knowledgeRow({ version: 1, source_versions: { [S1]: 1 } })],
      jobs: [{
        id: existingReceiptId,
        workspace_id: W,
        owner_user_id: U,
        key: `build-course-knowledge:${C}:same-key-replay`,
        kind: "build-course-knowledge",
        payload: { courseId: C },
        result: null,
        state: "failed",
        privacy_epoch: 0,
        created_at: new Date(1),
        updated_at: new Date(1),
      }],
    });
    const repo = createOpeningKnowledgeRepository(db.sql);

    const blockedSync = await repo.readSyncStatus(scope, C, { includeDetails: true });
    expect(blockedSync.rebuildBlockedByMaterials).toBe(true);
    expect(blockedSync.unreadableSourceCount).toBe(1);

    // Auto reconcile skips enqueue
    const rec = await repo.reconcileCourseMaterials(scope, C);
    expect(rec.enqueued).toBeNull();

    // New manual POST returns CONFLICT + MATERIAL_REPLACEMENT_BLOCKED
    await expect(
      repo.enqueueRebuild(scope, C, { clientKey: "fresh-manual-key-1" }),
    ).rejects.toMatchObject({ code: "CONFLICT", reason: "MATERIAL_REPLACEMENT_BLOCKED" });

    // Same-key replay still returns existing receipt without 409
    await expect(
      repo.enqueueRebuild(scope, C, { clientKey: "same-key-replay" }),
    ).resolves.toEqual({ jobId: existingReceiptId, kind: "build-course-knowledge", created: false });

    // Destructive replace while sBad is unreadable is rejected
    expect(db.knowledge.get(C)!.version).toBe(2);
    await expect(
      repo.replace(scope, C, {
        expectedVersion: 2,
        extractedSourceVersions: {},
        snapshot: { courseId: C, version: 3, nodes: [], edges: [] },
        sourceVersions: {},
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", reason: "MATERIAL_REPLACEMENT_BLOCKED" });

    // Even if sBad recovers BEFORE replace/CAS retry, stale extractedSourceVersions={} is STILL rejected
    db.sources.get(sBad)!.parseState = "ready";
    db.sources.get(sBad)!.hasChunk = true;
    db.sources.get(sBad)!.hasTextChunk = true;
    await expect(
      repo.replace(scope, C, {
        expectedVersion: 2,
        extractedSourceVersions: {},
        snapshot: { courseId: C, version: 3, nodes: [], edges: [] },
        sourceVersions: {},
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", reason: "MATERIAL_REPLACEMENT_BLOCKED" });
    expect(
      db.knowledge.get(C)!.snapshot.nodes.map((node) => ({ id: node.id, evidenceChunkIds: node.evidenceChunkIds })),
    ).toEqual([{ id: N1, evidenceChunkIds: [CH1] }]);

    // Adding an unreadable scan when old graph evidence S1 is still valid does NOT block
    db.sources.get(S1)!.attached = true;
    db.sources.get(sBad)!.parseState = "failed";
    db.sources.get(sBad)!.hasChunk = false;
    db.sources.get(sBad)!.hasTextChunk = false;
    expect((await repo.readSyncStatus(scope, C, { includeDetails: true })).rebuildBlockedByMaterials).toBe(false);

    // Mandatory privacy exclusion of S1 is NEVER blocked even when sBad is unreadable
    db.sources.get(S1)!.excluded = true;
    expect((await repo.readSyncStatus(scope, C, { includeDetails: true })).rebuildBlockedByMaterials).toBe(false);
    const cleanup = await repo.reconcileCourseMaterials(scope, C);
    expect(cleanup.enqueued?.created).toBe(true);
  });

  it("scopes mandatory cleanup exemption per source so restricting B never lifts protection for A whose replacement failed", async () => {
    const N2 = "00000000-0000-4000-8000-000000000022";
    const CH2 = "00000000-0000-4000-8000-000000000032";
    const sBadA = "00000000-0000-4000-8000-000000000017";
    const db = makeFakeSql({
      sources: [
        // Source A (S1) was replaced by failed sBadA (unlinked, not deleted/excluded/restricted)
        { id: S1, version: 1, uploadState: "uploaded", parseState: "ready", available: true, excluded: false, hasChunk: true, attached: false, purpose: "teaching" },
        { id: sBadA, version: 1, uploadState: "uploaded", parseState: "failed", available: true, excluded: false, hasChunk: false, attached: true, purpose: "teaching" },
        // Source B (S2) was switched to practice purpose (mandatory cleanup for B ONLY)
        { id: S2, version: 1, uploadState: "uploaded", parseState: "ready", available: true, excluded: false, hasChunk: true, attached: true, purpose: "practice" },
      ],
      knowledgeRows: [
        knowledgeRow({
          version: 2,
          snapshot: {
            courseId: C,
            version: 2,
            nodes: [
              { id: N1, courseId: C, label: "来源A核心定理", kind: "concept", evidenceChunkIds: [CH1], status: "supported" },
              { id: N2, courseId: C, label: "来源B习题概念", kind: "concept", evidenceChunkIds: [CH2], status: "supported" },
            ],
            edges: [],
          },
          source_versions: { [S1]: 1, [S2]: 1 },
        }),
      ],
    });
    const repo = createOpeningKnowledgeRepository(db.sql);

    const sync = await repo.readSyncStatus(scope, C, { includeDetails: true });
    expect(sync.rebuildBlockedByMaterials).toBe(true);
    expect(sync.unreadableSourceCount).toBe(1);

    expect((await repo.reconcileCourseMaterials(scope, C)).enqueued).toBeNull();
    await expect(
      repo.enqueueRebuild(scope, C, { clientKey: "mixed-cleanup-blocked-key" }),
    ).rejects.toMatchObject({ code: "CONFLICT", reason: "MATERIAL_REPLACEMENT_BLOCKED" });

    // Worker attempting empty overwrite must be blocked and preserve A's exact node ID and evidence chunk ID
    await expect(
      repo.replace(scope, C, {
        expectedVersion: db.knowledge.get(C)!.version,
        extractedSourceVersions: {},
        snapshot: { courseId: C, version: db.knowledge.get(C)!.version + 1, nodes: [], edges: [] },
        sourceVersions: {},
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", reason: "MATERIAL_REPLACEMENT_BLOCKED" });

    const preserved = db.knowledge.get(C)!;
    expect(preserved.source_versions).toEqual({ [S1]: 1, [S2]: 1 });
    expect(preserved.snapshot.nodes.find((node) => node.id === N1)).toMatchObject({
      id: N1,
      evidenceChunkIds: [CH1],
    });
  });

  it("allows same-ID readable version upgrade (V@1 -> V@2) despite an unrelated unreadable image-only source while still blocking when V@2 is unreadable", async () => {
    const CH_V2 = "00000000-0000-4000-8000-000000000039";
    const N_V2 = "00000000-0000-4000-8000-000000000029";
    const db = makeFakeSql({
      sources: [
        // Video V (S1) upgraded in-place from version 1 -> 2 and is ready with readable transcript text
        { id: S1, version: 2, uploadState: "uploaded", parseState: "ready", available: true, excluded: false, hasChunk: true, hasTextChunk: true, attached: true, purpose: "teaching" },
        // Unrelated pure-image source B (S2) contributes unreadableSourceCount=1
        { id: S2, version: 1, uploadState: "uploaded", parseState: "ready", available: true, excluded: false, hasChunk: true, hasTextChunk: false, attached: true, purpose: "teaching" },
      ],
      chunks: [{ id: CH_V2, sourceId: S1, sourceVersion: 2, text: "更新后的视频转写正文" }],
      knowledgeRows: [knowledgeRow({ version: 1, source_versions: { [S1]: 1 } })],
    });
    const repo = createOpeningKnowledgeRepository(db.sql);

    const sync = await repo.readSyncStatus(scope, C, { includeDetails: true });
    expect(sync.status).toBe("needs_rebuild");
    expect(sync.unreadableSourceCount).toBe(1);
    expect(sync.eligibleSourceVersions).toEqual({ [S1]: 2 });
    expect(sync.rebuildBlockedByMaterials).toBe(false);

    // Enqueue and write-side replace both succeed for readable V@2
    const enqueued = await repo.enqueueRebuild(scope, C, { clientKey: "same-id-upgrade-v2" });
    expect(enqueued.created).toBe(true);

    const replaced = await repo.replace(scope, C, {
      expectedVersion: 1,
      extractedSourceVersions: { [S1]: 2 },
      snapshot: {
        courseId: C,
        version: 2,
        nodes: [{ id: N_V2, courseId: C, label: "新版视频概念", kind: "concept", evidenceChunkIds: [CH_V2], status: "supported" }],
        edges: [],
      },
      sourceVersions: { [S1]: 2 },
    });
    expect(replaced.version).toBe(2);
    expect(replaced.sourceVersions).toEqual({ [S1]: 2 });

    // Contrast: if S1 upgrades to V@3 which is still failed/unreadable, protection MUST engage
    db.sources.get(S1)!.version = 3;
    db.sources.get(S1)!.parseState = "failed";
    db.sources.get(S1)!.hasChunk = false;
    db.sources.get(S1)!.hasTextChunk = false;
    const blockedSync = await repo.readSyncStatus(scope, C, { includeDetails: true });
    expect(blockedSync.rebuildBlockedByMaterials).toBe(true);
    await expect(
      repo.enqueueRebuild(scope, C, { clientKey: "same-id-upgrade-v3-failed" }),
    ).rejects.toMatchObject({ code: "CONFLICT", reason: "MATERIAL_REPLACEMENT_BLOCKED" });
  });

  it("reads knowledge snapshot, material counts, and job states inside one REPEATABLE READ READ ONLY snapshot transaction", async () => {
    const jobId = randomUUID();
    let mutatedDuringRead = false;
    const db = makeFakeSql({
      sources: [{ id: S1, version: 1, uploadState: "uploaded", parseState: "ready", available: true, excluded: false, hasChunk: true, purpose: "teaching" }],
      knowledgeRows: [knowledgeRow({ version: 1, source_versions: { [S1]: 1 } })],
      jobs: [{
        id: jobId,
        workspace_id: W,
        owner_user_id: U,
        key: "k-snapshot-race",
        kind: "build-course-knowledge",
        payload: { courseId: C },
        result: null,
        state: "running",
        privacy_epoch: 0,
        created_at: new Date(10),
        updated_at: new Date(10),
      }],
      onQuery: (query) => {
        // Simulate worker committing 0-node V2 + succeeded right after opening_course_knowledge is read
        if (!mutatedDuringRead && query.startsWith("SELECT version, snapshot, source_versions FROM opening_course_knowledge")) {
          mutatedDuringRead = true;
          db.knowledge.set(C, knowledgeRow({
            version: 2,
            snapshot: { courseId: C, version: 2, nodes: [], edges: [] },
            source_versions: {},
          }));
          db.jobs[0]!.state = "succeeded";
          db.jobs[0]!.result = { version: 2, coveredSourceVersions: { [S1]: 1 } };
          db.jobs[0]!.updated_at = new Date(20);
        }
      },
    });
    const repo = createOpeningKnowledgeRepository(db.sql);

    const firstRead = await repo.getWithSync(scope, C, { includeDetails: true, requestedJobId: jobId });
    expect(mutatedDuringRead).toBe(true);
    expect(db.transactions.at(-1)?.repeatableReadOnly).toBe(true);
    expect(db.transactions.at(-1)?.statements[0]).toBe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    // Must never splice V1 old nodes with post-commit succeeded state
    expect(firstRead.version).toBe(1);
    expect(firstRead.snapshot.nodes).toHaveLength(1);
    expect(firstRead.sync?.requestedJob).toEqual({ jobId, state: "running" });
    expect(firstRead.sync?.activeJobId).toBe(jobId);

    // Subsequent snapshot sees both V2 empty graph and succeeded job consistently
    const secondRead = await repo.getWithSync(scope, C, { includeDetails: true, requestedJobId: jobId });
    expect(db.transactions.at(-1)?.repeatableReadOnly).toBe(true);
    expect(secondRead.version).toBe(2);
    expect(secondRead.snapshot.nodes).toHaveLength(0);
    expect(secondRead.sync?.requestedJob).toEqual({ jobId, state: "succeeded" });
    expect(secondRead.sync?.activeJobId).toBeNull();
  });
});
