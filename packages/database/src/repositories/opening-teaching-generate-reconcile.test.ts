import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { decideTeachingGenerateReconcile, reconcileTeachingGenerate, type TeachingGenerateReconcileInput } from "./opening-teaching-generate-reconcile";

const failOpeningJob = vi.hoisted(() => vi.fn());
vi.mock("./opening-job-failure", () => ({ failOpeningJob }));
vi.mock("./opening-learning-facts", () => ({ lockLearningOwner: vi.fn(async () => undefined) }));

const staleMs = 15 * 60_000;
const nowMs = Date.parse("2026-10-25T12:00:00Z");
const input = (overrides: Partial<TeachingGenerateReconcileInput>): TeachingGenerateReconcileInput => ({
  generateStatus: "queued", contentVersion: 0, job: null, nowMs, staleMs, ...overrides,
});
const job = (state: NonNullable<TeachingGenerateReconcileInput["job"]>["state"], ageMs: number, expectedContentVersion: number | null = 0) =>
  ({ state, updatedAtMs: nowMs - ageMs, expectedContentVersion });

describe("decideTeachingGenerateReconcile", () => {
  it("never touches a lesson that is not in flight", () => {
    for (const generateStatus of ["ready", "needs_check", "failed", "unknown", "cancelled", "stale"] as const) {
      expect(decideTeachingGenerateReconcile(input({ generateStatus, job: job("failed", 0) }))).toEqual({ action: "none" });
    }
  });

  it("waits for a live job, queued or heart-beating, until the timeout", () => {
    expect(decideTeachingGenerateReconcile(input({ job: job("queued", staleMs - 1) }))).toEqual({ action: "none" });
    expect(decideTeachingGenerateReconcile(input({ generateStatus: "generating", job: job("running", 60_000) }))).toEqual({ action: "none" });
  });

  it("expires a job whose queue message was lost or whose worker died", () => {
    expect(decideTeachingGenerateReconcile(input({ job: job("queued", staleMs) }))).toEqual({ action: "expire_job", jobState: "queued" });
    expect(decideTeachingGenerateReconcile(input({ generateStatus: "generating", job: job("running", staleMs + 1) })))
      .toEqual({ action: "expire_job", jobState: "running" });
  });

  it("ends the lesson immediately when its job is missing or already over", () => {
    expect(decideTeachingGenerateReconcile(input({}))).toMatchObject({ action: "mark_activity", generateStatus: "failed", reason: "job_missing" });
    for (const state of ["failed", "outcome_unknown"] as const) {
      expect(decideTeachingGenerateReconcile(input({ job: job(state, 0) }))).toMatchObject({ action: "mark_activity", generateStatus: "failed" });
    }
    expect(decideTeachingGenerateReconcile(input({ job: job("cancelled", 0) }))).toMatchObject({ generateStatus: "cancelled" });
  });

  it("keeps published content readable when a succeeded job lost its status fence", () => {
    expect(decideTeachingGenerateReconcile(input({ generateStatus: "generating", contentVersion: 1, job: job("succeeded", 0, 0) })))
      .toMatchObject({ action: "mark_activity", generateStatus: "needs_check" });
    expect(decideTeachingGenerateReconcile(input({ generateStatus: "generating", contentVersion: 0, job: job("succeeded", 0, 0) })))
      .toMatchObject({ action: "mark_activity", generateStatus: "failed" });
  });
});

describe("reconcileTeachingGenerate", () => {
  const scope = { workspaceId: "00000000-0000-4000-8000-000000000001", ownerUserId: "00000000-0000-4000-8000-000000000002" };
  const activityId = "00000000-0000-4000-8000-000000000003";
  let activityStatus: string;
  let jobRow: Record<string, unknown> | null;
  const writes: string[] = [];

  function fakeSql(): Sql {
    const sql = ((strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("UPDATE opening_teaching_activities")) {
        writes.push(query);
        activityStatus = "failed";
        return Promise.resolve([{ generate_status: "failed" }]);
      }
      if (query.includes("FROM opening_teaching_activities")) return Promise.resolve([{ generate_status: activityStatus, content_version: 0 }]);
      if (query.includes("FROM opening_jobs")) return Promise.resolve(jobRow ? [jobRow] : []);
      throw new Error(`unexpected query ${query}`);
    }) as unknown as Sql;
    sql.begin = ((callback: (tx: Sql) => unknown) => callback(sql)) as Sql["begin"];
    return sql;
  }

  beforeEach(() => {
    writes.length = 0;
    failOpeningJob.mockReset();
  });

  it("fails a stale queued job through the shared terminal path, then fences the activity", async () => {
    activityStatus = "queued";
    const now = new Date(nowMs);
    jobRow = { id: "job-1", state: "queued", updated_at: new Date(nowMs - staleMs - 1), expected_content_version: "0", now };
    failOpeningJob.mockImplementation(async () => { jobRow = { ...jobRow, state: "failed" }; return true; });
    const result = await reconcileTeachingGenerate(fakeSql(), scope, activityId, { staleMs });
    expect(failOpeningJob).toHaveBeenCalledWith(expect.anything(), "job-1", expect.objectContaining({ code: "TEACHING_GENERATE_STALE" }),
      "failed", { expectedState: "queued", staleBefore: new Date(nowMs - staleMs + 1) });
    expect(writes).toHaveLength(1);
    expect(result).toEqual({ changed: true, generateStatus: "failed", reason: "job_queued_stale" });
  });

  it("leaves a fresh job alone and never writes", async () => {
    activityStatus = "generating";
    jobRow = { id: "job-2", state: "running", updated_at: new Date(nowMs - 1000), expected_content_version: "0", now: new Date(nowMs) };
    expect(await reconcileTeachingGenerate(fakeSql(), scope, activityId, { staleMs })).toEqual({ changed: false, generateStatus: "generating" });
    expect(failOpeningJob).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("marks an activity with no compile job failed", async () => {
    activityStatus = "queued";
    jobRow = null;
    expect(await reconcileTeachingGenerate(fakeSql(), scope, activityId, { staleMs }))
      .toEqual({ changed: true, generateStatus: "failed", reason: "job_missing" });
  });
});
