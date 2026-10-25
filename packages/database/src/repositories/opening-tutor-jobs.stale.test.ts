import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { createOpeningTutorJobsRepository } from "./opening-tutor-jobs";

const scope = { workspaceId: "00000000-0000-4000-8000-000000000001", ownerUserId: "00000000-0000-4000-8000-000000000002" };
const jobId = "00000000-0000-4000-8000-000000000003";
const staleBefore = new Date("2026-10-25T11:50:00Z");

type Job = { id: string; workspace_id: string; status: string; error: unknown; stale: boolean };

function fakeSql(jobs: Job[]) {
  const writes: Array<{ query: string; values: unknown[] }> = [];
  const row = (job: Job) => ({ ...job, conversation_id: "c", user_turn_id: "u", assistant_turn_id: "a", mode: "explain",
    created_at: new Date(), updated_at: new Date() });
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?");
    if (query.includes("FROM workspaces")) return Promise.resolve([{ id: scope.workspaceId }]);
    if (/UPDATE opening_tutor_jobs SET status = 'failed'/.test(query)) {
      writes.push({ query, values });
      const job = jobs.find(item => item.id === values[1] && item.stale && ["queued", "running"].includes(item.status));
      if (!job) return Promise.resolve([]);
      job.status = "failed"; job.error = values[0];
      return Promise.resolve([{ assistant_turn_id: "a" }]);
    }
    if (/UPDATE opening_tutor_jobs SET status = 'outcome_unknown'/.test(query)) {
      writes.push({ query, values });
      const job = jobs.find(item => item.id === values[1] && item.stale && item.status === "running");
      if (!job) return Promise.resolve([]);
      job.status = "outcome_unknown";
      return Promise.resolve([{ assistant_turn_id: "a" }]);
    }
    if (query.includes("UPDATE opening_turns")) { writes.push({ query, values }); return Promise.resolve([]); }
    if (query.includes("make_interval")) {
      const id = values[2] as string | null;
      return Promise.resolve(jobs.filter(job => job.stale && ["queued", "running"].includes(job.status) && (!id || job.id === id))
        .map(job => ({ id: job.id, workspace_id: job.workspace_id, status: job.status, stale_before: staleBefore })));
    }
    if (query.includes("SELECT j.* FROM opening_tutor_jobs")) return Promise.resolve(jobs.filter(job => job.id === values[0]).map(row));
    throw new Error(`unexpected query ${query}`);
  }) as unknown as Sql;
  sql.begin = ((callback: (tx: Sql) => unknown) => callback(sql)) as Sql["begin"];
  sql.json = ((value: unknown) => value) as Sql["json"];
  return { sql, writes };
}

describe("tutor job stale reconciliation", () => {
  it("a polled job whose queue message was lost ends failed with code TUTOR_JOB_STALE", async () => {
    const jobs: Job[] = [{ id: jobId, workspace_id: scope.workspaceId, status: "queued", error: null, stale: true }];
    const { sql, writes } = fakeSql(jobs);
    const job = await createOpeningTutorJobsRepository(sql, { staleMs: 600_000 }).get(scope, jobId);
    expect(job?.status).toBe("failed");
    expect(job?.error).toMatchObject({ code: "TUTOR_JOB_STALE" });
    const failed = writes.find(write => write.query.includes("SET status = 'failed'"))!;
    expect(failed.values[0]).toMatchObject({ code: "TUTOR_JOB_STALE" });
    expect(failed.values).toContain(staleBefore);
    expect(writes.some(write => write.query.includes("UPDATE opening_turns SET text") && write.query.includes("'failed'"))).toBe(true);
  });

  it("without the option (or for a fresh job) get is a pure read", async () => {
    const stale: Job[] = [{ id: jobId, workspace_id: scope.workspaceId, status: "queued", error: null, stale: true }];
    const plain = fakeSql(stale);
    expect((await createOpeningTutorJobsRepository(plain.sql).get(scope, jobId))?.status).toBe("queued");
    expect(plain.writes).toEqual([]);
    const fresh = fakeSql([{ id: jobId, workspace_id: scope.workspaceId, status: "queued", error: null, stale: false }]);
    expect((await createOpeningTutorJobsRepository(fresh.sql, { staleMs: 600_000 }).get(scope, jobId))?.status).toBe("queued");
    expect(fresh.writes).toEqual([]);
  });

  it("the worker sweep never re-runs a running job: no heartbeat becomes outcome_unknown", async () => {
    const jobs: Job[] = [
      { id: jobId, workspace_id: scope.workspaceId, status: "running", error: null, stale: true },
      { id: "00000000-0000-4000-8000-000000000004", workspace_id: scope.workspaceId, status: "queued", error: null, stale: true },
    ];
    const { sql } = fakeSql(jobs);
    expect(await createOpeningTutorJobsRepository(sql).expireStale({ staleMs: 600_000 })).toBe(2);
    expect(jobs.map(job => job.status)).toEqual(["outcome_unknown", "failed"]);
  });
});
