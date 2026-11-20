import type { Sql } from "postgres";
import { expect, it, vi } from "vitest";
import { scheduleRetell } from "./retell-task";

vi.mock("@aistudy/database", async importOriginal => ({
  ...await importOriginal<typeof import("@aistudy/database")>(), lockWorkspaceLearningHistory: vi.fn(),
}));

const sourceId = "8eedacc6-7ef4-4f77-8f51-ec76b9520f18";
const scope = { workspaceId: "db3cdb6b-2e89-420a-8307-1ca6aa96675f", ownerUserId: "b96f7ec5-777d-4dd8-a6cb-2e7c701406ce" };
const tomorrow = new Date("2026-11-01T07:00:00Z");

function transaction(active: boolean, lastAt: Date | null) {
  let stored: { id: unknown; client_key: unknown; course_id: unknown; not_before: unknown } | undefined;
  const windows = vi.fn(() => [{ active, last_at: lastAt, tomorrow }]);
  const writes = vi.fn((values: unknown[]) => {
    const [id, , , course_id, , client_key, not_before] = values;
    stored = { id, course_id, client_key, not_before };
    return [];
  });
  const query = vi.fn(async (sql: TemplateStringsArray, ...values: unknown[]) => {
    const text = sql.join("?");
    if (text.includes("FROM courses")) return [{ id: values[0] }];
    if (text.includes("SELECT id, client_key")) return stored ? [stored] : [];
    if (text.includes("FROM workspace_preferences")) return [{ zone: "America/Los_Angeles" }];
    if (text.includes("FROM opening_sources")) return [{ id: sourceId }];
    if (text.includes("FROM opening_retest_activities")) return windows();
    if (text.includes("INSERT INTO opening_tasks")) return writes(values);
    throw new Error("Unexpected scheduling query");
  });
  const sql = { begin: (fn: (tx: typeof query) => unknown) => fn(query) } as unknown as Sql;
  return { sql, writes, windows, query };
}

it.each([
  [false, null, tomorrow.toISOString()],
  [true, null, "2026-11-01T07:00:01.000Z"],
  [true, new Date("2026-10-20T00:00Z"), "2026-11-01T07:00:01.000Z"],
  [true, new Date("2026-11-03T11:32:51.765Z"), "2026-11-03T11:32:52.765Z"],
] as const)("persists the guarded start and replays the original decision (%#)", async (active, lastAt, expected) => {
  const db = transaction(active, lastAt);
  const input = { sourceId, title: "导数" };
  const first = await scheduleRetell(db.sql, scope, input);
  expect(first).toEqual({ taskId: sourceId, replayed: false, notBefore: new Date(expected), deferredBehindActiveRetest: active });
  expect(await scheduleRetell(db.sql, scope, input)).toEqual({ ...first, replayed: true });
  expect(db.writes).toHaveBeenCalledTimes(1);
  expect(db.windows).toHaveBeenCalledTimes(1);
  if (active) expect(db.writes.mock.calls[0]![0][4]).not.toContain(input.title);
  const windowQuery = db.query.mock.calls.find(([parts]) => parts.join("").includes("FROM opening_retest_activities"));
  expect(windowQuery?.slice(1)).toEqual(["America/Los_Angeles", "America/Los_Angeles",
    scope.workspaceId, scope.ownerUserId, null, null]);
});

it("scopes the retest window to the requested course and rejects rebinding a replay", async () => {
  const db = transaction(true, tomorrow);
  const input = { sourceId, title: "复述", timeZone: "UTC", courseId: "9a445539-4069-40ea-a981-eeafc28b6553" };
  await scheduleRetell(db.sql, scope, input);
  const windowQuery = db.query.mock.calls.find(([parts]) => parts.join("").includes("FROM opening_retest_activities"));
  expect(windowQuery?.slice(1)).toEqual(["UTC", "UTC", scope.workspaceId, scope.ownerUserId, input.courseId, input.courseId]);
  await expect(scheduleRetell(db.sql, scope, { ...input, courseId: null })).rejects.toMatchObject({ status: 409 });
  expect(db.writes).toHaveBeenCalledTimes(1);
});
