import { afterEach, describe, expect, it, vi } from "vitest";
import * as history from "./opening-learning-facts";
import type { Sql } from "postgres";
import { createOpeningJobRepository } from "./opening-jobs";

const workspaceId = "00000000-0000-4000-8000-0000000000w1";
const ownerUserId = "00000000-0000-4000-8000-0000000000o1";
const jobId = "00000000-0000-4000-8000-0000000000j1";
const activityId = "00000000-0000-4000-8000-0000000000a1";
const scope = { workspaceId, ownerUserId };

function db(handler: (query: string, values: unknown[]) => unknown[]) {
  const writes: Array<{ query: string; values: unknown[] }> = [];
  const sql = ((strings: TemplateStringsArray | unknown[], ...values: unknown[]) => {
    if (!Object.hasOwn(strings as object, "raw")) return strings;
    const query = (strings as TemplateStringsArray).join("?");
    if (/INSERT|UPDATE|DELETE/.test(query)) writes.push({ query, values });
    if (query.includes("SELECT w.id, w.owner_user_id")) return Promise.resolve([{ id: workspaceId, owner_user_id: ownerUserId }]);
    if (query.includes("SELECT workspace_id, owner_user_id")) return Promise.resolve([{ workspace_id: workspaceId, owner_user_id: ownerUserId }]);
    if (query.includes("SELECT id FROM workspaces") || query.includes("SELECT id FROM opening_sources")) return Promise.resolve([{ id: workspaceId }]);
    return Promise.resolve(handler(query, values));
  }) as unknown as Sql;
  sql.begin = ((callback: (tx: Sql) => unknown) => callback(sql)) as Sql["begin"];
  sql.json = ((value: unknown) => value) as Sql["json"];
  return { sql, writes };
}

describe("opening_jobs.cancel (V2-07)", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["NOT_FOUND", "workspace not found"], ["NOT_FOUND", "other missing"], ["55P03", "lock unavailable"],
  ])("propagates helper error identity %s / %s when candidate is unchanged", async (code, message) => {
    const error = Object.assign(new Error(message), { code });
    vi.spyOn(history, "lockWorkspaceLearningHistory").mockRejectedValueOnce(error);
    const { sql, writes } = db(query => query.includes("SELECT w.owner_user_id") ? [{ owner_user_id: ownerUserId }] : []);
    await expect(createOpeningJobRepository(sql).cancel(scope, jobId)).rejects.toBe(error);
    expect(writes).toEqual([]);
  });

  it.each(["owner", "missing"])("returns null only for confirmed helper-time %s identity drift", async drift => {
    const error = Object.assign(new Error("workspace not found"), { code: "NOT_FOUND" });
    vi.spyOn(history, "lockWorkspaceLearningHistory").mockRejectedValueOnce(error);
    const { sql, writes } = db(query => query.includes("SELECT w.owner_user_id") && drift === "owner" ? [{ owner_user_id: "changed" }] : []);
    expect(await createOpeningJobRepository(sql).cancel(scope, jobId)).toBeNull();
    expect(writes).toEqual([]);
  });
  it("cancels queued compile-teaching-unit and fences activity generate_status", async () => {
    const { sql, writes } = db((query) => {
      if (query.includes("FROM workspaces") || query.includes("SELECT id FROM workspaces")) {
        return [{ id: workspaceId }];
      }
      if (query.includes("UPDATE opening_jobs") && query.includes("cancelled")) {
        return [{
          id: jobId,
          workspace_id: workspaceId,
          owner_user_id: ownerUserId,
          key: `compile-teaching-unit:${activityId}:generate:ck`,
          kind: "compile-teaching-unit",
          payload: { activityId, mode: "generate", clientKey: "ck-123456", expectedContentVersion: 0 },
          result: null,
          state: "cancelled",
          privacy_epoch: 1,
        }];
      }
      return [];
    });
    const cancelled = await createOpeningJobRepository(sql).cancel(scope, jobId);
    expect(cancelled?.state).toBe("cancelled");
    expect(cancelled?.kind).toBe("compile-teaching-unit");
    expect(writes.some((w) => w.query.includes("opening_teaching_activities") && w.query.includes("cancelled"))).toBe(true);
  });

  it("fences queued parse cleanup by owner, version and other live jobs", async () => {
    const sourceId = "00000000-0000-4000-8000-000000000003";
    const { sql, writes } = db(query => query.includes("UPDATE opening_jobs") ? [{
      id: jobId, workspace_id: workspaceId, owner_user_id: ownerUserId, key: "retry",
      kind: "parse", payload: { sourceId, sourceVersion: 0 }, result: null, state: "cancelled", privacy_epoch: 1,
    }] : []);
    expect(await createOpeningJobRepository(sql).cancel(scope, jobId)).toMatchObject({ state: "cancelled" });
    const cleanup = writes.find(write => write.query.includes("s.parse_state='queued'"));
    expect(cleanup?.query).toContain("s.version=?");
    expect(cleanup?.query).toContain("w.owner_user_id=?");
    expect(cleanup?.query).toContain("active.state IN ('queued','running')");
    expect(cleanup?.values).toEqual([sourceId, workspaceId, 0, ownerUserId, sourceId]);
  });

  it("does not release queued state from an unfenced legacy parse payload", async () => {
    const { sql, writes } = db(query => query.includes("UPDATE opening_jobs") ? [{
      id: jobId, workspace_id: workspaceId, owner_user_id: ownerUserId, key: "legacy",
      kind: "parse", payload: { sourceId: "00000000-0000-4000-8000-000000000003" }, result: null, state: "cancelled", privacy_epoch: 1,
    }] : []);
    await createOpeningJobRepository(sql).cancel(scope, jobId);
    expect(writes.some(write => write.query.includes("s.parse_state='queued'"))).toBe(false);
  });

  it("returns null when job is not queued/running", async () => {
    const { sql } = db((query) => {
      if (query.includes("SELECT id FROM workspaces")) return [{ id: workspaceId }];
      if (query.includes("UPDATE opening_jobs")) return [];
      return [];
    });
    expect(await createOpeningJobRepository(sql).cancel(scope, jobId)).toBeNull();
  });
});
