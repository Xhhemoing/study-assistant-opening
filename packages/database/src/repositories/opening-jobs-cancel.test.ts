import { describe, expect, it } from "vitest";
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
    return Promise.resolve(handler(query, values));
  }) as unknown as Sql;
  sql.begin = ((callback: (tx: Sql) => unknown) => callback(sql)) as Sql["begin"];
  sql.json = ((value: unknown) => value) as Sql["json"];
  return { sql, writes };
}

describe("opening_jobs.cancel (V2-07)", () => {
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

  it("returns null when job is not queued/running", async () => {
    const { sql } = db((query) => {
      if (query.includes("SELECT id FROM workspaces")) return [{ id: workspaceId }];
      if (query.includes("UPDATE opening_jobs")) return [];
      return [];
    });
    expect(await createOpeningJobRepository(sql).cancel(scope, jobId)).toBeNull();
  });
});
