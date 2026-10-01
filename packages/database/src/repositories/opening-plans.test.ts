import { describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { createOpeningPlansRepository } from "./opening-plans";

const scope = { workspaceId: "workspace", ownerUserId: "owner" };
const task = { id: "task", title: "Due task", minutes: 25, due_at: null, priority: 1, status: "pending", version: 4 };

describe("opening task response versions", () => {
  it("returns the stored task version from the owner list", async () => {
    const query = vi.fn().mockResolvedValue([task]);
    expect(await createOpeningPlansRepository(query as unknown as Sql).listTasks(scope))
      .toEqual([{ id: "task", title: "Due task", minutes: 25, dueAt: null, priority: 1, status: "pending", version: 4 }]);
  });

  it("returns the incremented task version after a status update", async () => {
    const taskRow = { id: "task", title: "Due task", minutes: 25, due_at: null, priority: 1, status: "pending", version: 4 };
    const query = vi.fn(async (parts: TemplateStringsArray) => {
      const queryText = parts.join("?").replace(/\s+/g, " ").trim();
      if (queryText.startsWith("SELECT id FROM workspaces")) return [{ id: scope.workspaceId }];
      if (queryText.startsWith("INSERT INTO opening_workspace_history_revisions")) return [];
      if (queryText.startsWith("SELECT revision FROM opening_workspace_history_revisions")) return [{ revision: 9 }];
      if (queryText.startsWith("UPDATE opening_workspace_history_revisions")) return [{ revision: 10 }];
      if (queryText.startsWith("SELECT id, status, candidate_id FROM opening_retest_activities")) return [];
      if (queryText.startsWith("SELECT * FROM opening_tasks")) return [taskRow];
      if (queryText.startsWith("UPDATE opening_tasks")) return [{ ...taskRow, status: "done", version: 5 }];
      return [];
    });
    const sql = Object.assign(query, { begin: async (run: (tx: Sql) => Promise<unknown>) => run(query as unknown as Sql) });
    expect(await createOpeningPlansRepository(sql as unknown as Sql).updateTaskStatus(scope, task.id, {
      status: "done", expectedVersion: 4, at: "2026-09-30T04:00:00.000Z",
    })).toMatchObject({ status: "done", version: 5 });
  });
});
