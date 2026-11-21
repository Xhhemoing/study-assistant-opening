import type { Sql } from "postgres";
import { expect, it, vi } from "vitest";

const fence = vi.hoisted(() => ({ call: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./opening-learning-facts", () => ({ lockWorkspaceLearningHistory: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./opening-tutor-stream-fence", () => ({ fenceCancelledOpeningTutorStream: fence.call }));

import { createOpeningTutorJobsRepository } from "./opening-tutor-jobs";

const mixedWorkspaceId = "ABCDEFAB-ABCD-4ABC-8ABC-ABCDEFABCDEF";
const mixedJobId = "12345678-1234-4123-8123-123456789ABC";
const canonicalWorkspaceId = mixedWorkspaceId.toLowerCase();
const canonicalJobId = mixedJobId.toLowerCase();

function fakeSql(events: string[]) {
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?");
    if (query.includes("SELECT owner_user_id FROM workspaces")) {
      return Promise.resolve([{ owner_user_id: "owner" }]);
    }
    if (query.includes("SELECT id, owner_user_id FROM workspaces")) {
      return Promise.resolve([{ id: canonicalWorkspaceId, owner_user_id: "owner" }]);
    }
    if (query.includes("UPDATE opening_tutor_jobs SET status = 'failed'")) {
      return Promise.resolve([{
        id: canonicalJobId, workspace_id: canonicalWorkspaceId, assistant_turn_id: "assistant", timing_execution_id: "execution",
      }]);
    }
    if (query.includes("UPDATE opening_tutor_jobs SET status = 'outcome_unknown'")) {
      return Promise.resolve([{
        id: canonicalJobId, workspace_id: canonicalWorkspaceId, assistant_turn_id: "assistant", timing_execution_id: "execution",
      }]);
    }
    if (query.includes("UPDATE opening_turns")) {
      events.push("turn");
      return Promise.resolve([]);
    }
    throw new Error(`unexpected query ${query} values ${JSON.stringify(values)}`);
  }) as unknown as Sql;
  sql.begin = ((callback: (tx: Sql) => unknown) => callback(sql)) as Sql["begin"];
  sql.json = ((value: unknown) => value) as Sql["json"];
  return sql;
}

it.each(["fail", "markUnknown"] as const)(
  "%s fences using returned canonical IDs after updating the terminal turn",
  async method => {
    fence.call.mockClear();
    const events: string[] = [];
    fence.call.mockImplementation(async () => { events.push("fence"); });
    const sql = fakeSql(events);
    const jobs = createOpeningTutorJobsRepository(sql, { tutorStreamRedisUrl: "redis://localhost:6379" });
    const repositoryMethod = method === "fail"
      ? jobs.fail({ workspaceId: mixedWorkspaceId, ownerUserId: "owner" }, mixedJobId, "failed", undefined, "claim")
      : jobs.markUnknown({ workspaceId: mixedWorkspaceId, ownerUserId: "owner" }, mixedJobId, "unknown", "claim");

    await repositoryMethod;
    expect(fence.call).toHaveBeenCalledWith(canonicalWorkspaceId, canonicalJobId, "execution", "redis://localhost:6379");
    expect(events).toEqual(["turn", "fence"]);
  },
);

it.each(["fail", "markUnknown", "cancel"] as const)(
  "%s commits PostgreSQL termination and clears timing_execution_id even during a Redis outage",
  async method => {
    fence.call.mockReset();
    fence.call.mockRejectedValueOnce(new Error("Redis fence timed out"));
    const queries: string[] = [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("?");
      queries.push(query);
      if (query.includes("SELECT owner_user_id FROM workspaces")) return Promise.resolve([{ owner_user_id: "owner" }]);
      if (query.includes("SELECT id, owner_user_id FROM workspaces")) {
        return Promise.resolve([{ id: canonicalWorkspaceId, owner_user_id: "owner" }]);
      }
      if (query.includes("UPDATE opening_tutor_jobs j")) {
        return Promise.resolve([{
          id: canonicalJobId, workspace_id: canonicalWorkspaceId, conversation_id: "conv",
          user_turn_id: "user", assistant_turn_id: "assistant", status: "cancelled", mode: "hint",
          error: { message: "cancelled by user" }, created_at: "2026-11-20T00:00:00.000Z",
          updated_at: "2026-11-20T00:00:01.000Z", timing_execution_id: null, prior_execution_id: "execution",
        }]);
      }
      if (query.includes("UPDATE opening_tutor_jobs SET status =")) {
        return Promise.resolve([{
          id: canonicalJobId, workspace_id: canonicalWorkspaceId, assistant_turn_id: "assistant", timing_execution_id: "execution",
        }]);
      }
      if (query.includes("UPDATE opening_turns")) return Promise.resolve([]);
      throw new Error(`unexpected query ${query} values ${JSON.stringify(values)}`);
    }) as unknown as Sql;
    sql.begin = ((callback: (tx: Sql) => unknown) => callback(sql)) as Sql["begin"];
    sql.json = ((value: unknown) => value) as Sql["json"];

    const jobs = createOpeningTutorJobsRepository(sql, { tutorStreamRedisUrl: "redis://localhost:6379" });
    if (method === "fail") {
      await expect(jobs.fail({ workspaceId: mixedWorkspaceId, ownerUserId: "owner" }, mixedJobId, "failed", undefined, "claim"))
        .resolves.toBeUndefined();
    } else if (method === "markUnknown") {
      await expect(jobs.markUnknown({ workspaceId: mixedWorkspaceId, ownerUserId: "owner" }, mixedJobId, "unknown", "claim"))
        .resolves.toBeUndefined();
    } else {
      await expect(jobs.cancel({ workspaceId: mixedWorkspaceId, ownerUserId: "owner" }, mixedJobId))
        .resolves.toMatchObject({ id: canonicalJobId, status: "cancelled" });
    }
    expect(queries.some(query => query.includes("timing_execution_id = NULL"))).toBe(true);
    expect(fence.call).toHaveBeenCalledWith(canonicalWorkspaceId, canonicalJobId, "execution", "redis://localhost:6379");
  },
);

it("returns from cancel immediately without blocking on a hung post-commit Redis seal", async () => {
  fence.call.mockReset();
  fence.call.mockImplementationOnce(() => new Promise<void>(() => undefined));
  const sql = ((strings: TemplateStringsArray) => {
    const query = strings.join("?");
    if (query.includes("SELECT owner_user_id FROM workspaces")) return Promise.resolve([{ owner_user_id: "owner" }]);
    if (query.includes("SELECT id, owner_user_id FROM workspaces")) return Promise.resolve([{ id: canonicalWorkspaceId, owner_user_id: "owner" }]);
    if (query.includes("UPDATE opening_tutor_jobs j")) {
      return Promise.resolve([{
        id: canonicalJobId, workspace_id: canonicalWorkspaceId, conversation_id: "conv",
        user_turn_id: "user", assistant_turn_id: "assistant", status: "cancelled", mode: "hint",
        error: { message: "cancelled by user" }, created_at: "2026-11-20T00:00:00.000Z",
        updated_at: "2026-11-20T00:00:01.000Z", timing_execution_id: null, prior_execution_id: "execution",
      }]);
    }
    if (query.includes("UPDATE opening_turns")) return Promise.resolve([]);
    throw new Error(`unexpected query ${query}`);
  }) as unknown as Sql;
  sql.begin = ((callback: (tx: Sql) => unknown) => callback(sql)) as Sql["begin"];
  sql.json = ((value: unknown) => value) as Sql["json"];

  const jobs = createOpeningTutorJobsRepository(sql, { tutorStreamRedisUrl: "redis://localhost:6379" });
  await expect(jobs.cancel({ workspaceId: mixedWorkspaceId, ownerUserId: "owner" }, mixedJobId))
    .resolves.toMatchObject({ id: canonicalJobId, status: "cancelled" });
  expect(fence.call).toHaveBeenCalledWith(canonicalWorkspaceId, canonicalJobId, "execution", "redis://localhost:6379");
});
