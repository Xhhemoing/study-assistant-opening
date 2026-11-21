import { describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { DEFAULT_OPENING_INTERVENTION_PREFS, interventionPrefsSchema } from "@aistudy/contracts";
import { createOpeningPlansRepository } from "./opening-plans";

const scope = { workspaceId: "workspace", ownerUserId: "owner" };
const task = { id: "task", title: "Due task", minutes: 25, due_at: null, priority: 1, status: "pending", version: 4 };

it("accepts an untouched timetable revision only in its issuing workspace", async () => {
  const query = vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
    if (parts.join("").includes("FOR UPDATE")) return [{ id: values[0] }];
    return [];
  });
  const sql = Object.assign(query, { json: (value: unknown) => value,
    begin: (run: (tx: Sql) => unknown) => run(query as unknown as Sql) });
  const repo = createOpeningPlansRepository(sql as unknown as Sql);
  const { revision } = await repo.timetableSnapshot(scope);
  expect(revision).toBe(`empty:${scope.workspaceId}`);
  await expect(repo.replaceTimetable({ ...scope, workspaceId: "other" }, [], revision)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(query.mock.calls.some(([parts]) => parts.join("").includes("DELETE"))).toBe(false);
  await expect(repo.replaceTimetable(scope, [], revision)).resolves.toEqual([]);
});

it("derives timetable revisions from the rollback-safe history counter", async () => {
  let history: number | null = null;
  const query = vi.fn(async (parts: TemplateStringsArray) => {
    const text = parts.join("?").replace(/\s+/g, " ").trim();
    if (text.startsWith("SELECT id FROM workspaces")) return [{ id: scope.workspaceId }];
    if (text.startsWith("SELECT s.*, h.revision AS history_revision")) {
      return history === null ? [] : [{ id: null, history_revision: history }];
    }
    if (text.startsWith("INSERT INTO opening_workspace_history_revisions")) {
      history ??= 0;
      return [];
    }
    if (text.startsWith("UPDATE opening_workspace_history_revisions")) {
      history = (history ?? 0) + 1;
      return [];
    }
    return [];
  });
  const sql = Object.assign(query, { json: (value: unknown) => value,
    begin: (run: (tx: Sql) => unknown) => run(query as unknown as Sql) });
  const repo = createOpeningPlansRepository(sql as unknown as Sql);
  const before = await repo.timetableSnapshot(scope);
  await repo.replaceTimetable(scope, [], before.revision);
  const after = await repo.timetableSnapshot(scope);
  expect(after.sessions).toEqual([]);
  expect(after.revision).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(after.revision).not.toBe(before.revision);
  expect(query.mock.calls.some(([parts]) => parts.join("").includes("intervention_settings"))).toBe(false);
  expect(interventionPrefsSchema.parse(DEFAULT_OPENING_INTERVENTION_PREFS)).toEqual(DEFAULT_OPENING_INTERVENTION_PREFS);
});

describe("opening task response versions", () => {
  it("returns the stored task version from the owner list", async () => {
    const query = vi.fn().mockResolvedValue([task]);
    expect(await createOpeningPlansRepository(query as unknown as Sql).listTasks(scope))
      .toEqual([{ id: "task", title: "Due task", minutes: 25, dueAt: null, priority: 1, status: "pending", version: 4, retest: null }]);
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

  it("excludes pending tasks whose retest activity is inactive only when excludeInactiveRetests is enabled", async () => {
    const baseRetest = (id: string, status: string, taskStatus = "pending") => ({
      id,
      workspace_id: scope.workspaceId,
      owner_user_id: scope.ownerUserId,
      title: `Retest ${status}`,
      minutes: 25,
      due_at: "2026-10-26T19:00:00.000Z",
      not_before: "2026-10-15T19:00:00.000Z",
      priority: 1,
      status: taskStatus,
      version: 1,
      origin: "retest",
      course_id: "course-1",
      candidate_id: `cand-${id}`,
      retest_activity_id: `act-${id}`,
      retest_workspace_id: scope.workspaceId,
      retest_owner_user_id: scope.ownerUserId,
      retest_task_id: id,
      retest_course_id: "course-1",
      retest_purpose: "retest",
      retest_status: status,
      retest_skill_label: "矩阵秩",
      retest_prompt: "延迟复测",
      retest_recommended_at: "2026-10-15T19:00:00.000Z",
    });
    const rows = [
      task,
      baseRetest("retest-accepted", "accepted"),
      baseRetest("retest-in-progress", "in_progress"),
      baseRetest("retest-cancelled", "cancelled"),
      baseRetest("retest-declined", "declined"),
      baseRetest("retest-invalidated", "invalidated"),
      baseRetest("retest-superseded", "superseded"),
      baseRetest("retest-completed", "completed"),
      baseRetest("retest-done-task", "cancelled", "done"),
    ];
    const query = vi.fn().mockResolvedValue(rows);
    const repo = createOpeningPlansRepository(query as unknown as Sql);

    const unfiltered = await repo.listTasks(scope);
    expect(unfiltered.map(item => item.id)).toEqual(rows.map(item => item.id));

    const filtered = await repo.listTasks(scope, { excludeInactiveRetests: true });
    expect(filtered.map(item => item.id)).toEqual([
      "task",
      "retest-accepted",
      "retest-in-progress",
      "retest-done-task",
    ]);
  });
});
