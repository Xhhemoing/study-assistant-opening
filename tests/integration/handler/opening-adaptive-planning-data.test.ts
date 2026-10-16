import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, createSqlClient } from "@aistudy/database";
import type { Scope } from "@aistudy/contracts";
import { POST as register } from "../../../apps/web/src/app/api/auth/register/route";
import { GET as listTasks, POST as createTask } from "../../../apps/web/src/app/api/opening/tasks/route";
import { PATCH as patchTask } from "../../../apps/web/src/app/api/opening/tasks/[id]/route";
import { GET as getFeedback } from "../../../apps/web/src/app/api/opening/plans/feedback/route";
import { GET as getPrefs, PATCH as patchPrefs } from "../../../apps/web/src/app/api/opening/adaptive-planning/route";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";

const databaseUrl = process.env.DATABASE_URL ?? "";
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const sql = createSqlClient(databaseUrl);
let runtime: ReturnType<typeof createAuthRuntime> | undefined;
let owner: { cookie: string; scope: Scope };
let other: { cookie: string; scope: Scope };

async function registerUser(label: string) {
  const response = await register(new Request("http://localhost/api/auth/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `${label}-${randomUUID()}@example.com`, password: "password123", displayName: label }),
  }));
  expect(response.status).toBe(201);
  const body = await response.json() as { user: { id: string; workspaceId: string } };
  const token = response.headers.get("set-cookie")!.match(/aistudy_session=([^;]+)/)![1];
  return { cookie: `aistudy_session=${token}`, scope: { workspaceId: body.user.workspaceId, ownerUserId: body.user.id } };
}

async function createCourse(scope: Scope, archived = false) {
  const id = randomUUID();
  await sql`INSERT INTO courses(id, workspace_id, title, slug, archived_at)
    VALUES (${id}, ${scope.workspaceId}, '高等数学', ${`calculus-${id}`}, ${archived ? new Date() : null})`;
  return id;
}

function req(path: string, method: string, body: unknown, cookie: string) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const task = (extra: Record<string, unknown> = {}) => ({
  title: "极限入门", minutes: 25, dueAt: null, priority: 1, candidateId: null, ...extra,
});

async function newTask(extra: Record<string, unknown> = {}, cookie = owner.cookie) {
  const response = await createTask(req("/api/opening/tasks", "POST", task(extra), cookie));
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeAll(async () => {
  await applyMigrations(sql);
  runtime = createAuthRuntime({
    databaseUrl,
    authSecret: "opening-adaptive-planning-secret-32chars!",
    sessionCookieSecure: false,
    sessionTtlSeconds: 3600,
    authCookieName: "aistudy_session",
  });
  setAuthRuntimeForTests(runtime);
  owner = await registerUser("adaptive-owner");
  other = await registerUser("adaptive-other");
});

beforeEach(async () => {
  await sql`TRUNCATE opening_plan_acceptances, opening_plan_drafts, opening_plan_state, opening_hard_blocks, opening_tasks RESTART IDENTITY CASCADE`;
  await sql`UPDATE workspace_preferences SET adaptive_planning = NULL
    WHERE workspace_id IN (${owner.scope.workspaceId}, ${other.scope.workspaceId})`;
});

afterAll(async () => {
  setAuthRuntimeForTests(null);
  await runtime?.close();
  await sql.end({ timeout: 5 });
});

describe("adaptive planning data (L0)", () => {
  it("stores course, skill and origin on a created task and lists them back", async () => {
    const courseId = await createCourse(owner.scope);
    const created = await newTask({ courseId, skillLabel: "数列极限", origin: "course_seed", clientKey: `seed-${randomUUID()}` });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ courseId, skillLabel: "数列极限", origin: "course_seed" });

    const listed = await (await listTasks(req("/api/opening/tasks", "GET", undefined, owner.cookie))).json() as { tasks: Record<string, unknown>[] };
    expect(listed.tasks.find((item) => item.id === created.body.id)).toMatchObject({ courseId, skillLabel: "数列极限", origin: "course_seed" });
  });

  it("omits the new fields for a plain task so older payloads keep their shape", async () => {
    const created = await newTask();
    expect(created.status).toBe(201);
    expect(created.body).not.toHaveProperty("courseId");
    expect(created.body).not.toHaveProperty("origin");
    expect(created.body).not.toHaveProperty("notBefore");
  });

  it("rejects a course from another workspace or an archived course", async () => {
    expect((await newTask({ courseId: await createCourse(other.scope) })).status).toBe(404);
    expect((await newTask({ courseId: await createCourse(owner.scope, true) })).status).toBe(404);
    const [{ count }] = await sql`SELECT count(*)::int AS count FROM opening_tasks
      WHERE workspace_id = ${owner.scope.workspaceId}`;
    expect(count).toBe(0);
  });

  it("refuses server-assigned origins from the client", async () => {
    expect((await newTask({ origin: "planner" })).status).toBe(400);
  });

  it("defers a pending task with a version check and clears the deferral", async () => {
    const created = await newTask();
    const id = created.body.id as string;
    const notBefore = "2026-10-16T00:00:00.000Z";

    const deferred = await patchTask(req(`/api/opening/tasks/${id}`, "PATCH", { notBefore, expectedVersion: 1 }, owner.cookie), params(id));
    expect(deferred.status).toBe(200);
    expect(await deferred.json()).toMatchObject({ id, notBefore, version: 2 });

    const stale = await patchTask(req(`/api/opening/tasks/${id}`, "PATCH", { notBefore: null, expectedVersion: 1 }, owner.cookie), params(id));
    expect(stale.status).toBe(409);

    const cleared = await patchTask(req(`/api/opening/tasks/${id}`, "PATCH", { notBefore: null, expectedVersion: 2 }, owner.cookie), params(id));
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).not.toHaveProperty("notBefore");
  });

  it("does not defer finished tasks or another user's task", async () => {
    const created = await newTask();
    const id = created.body.id as string;
    const done = await patchTask(req(`/api/opening/tasks/${id}`, "PATCH",
      { status: "done", expectedVersion: 1, at: new Date().toISOString() }, owner.cookie), params(id));
    expect(done.status).toBe(200);
    const deferDone = await patchTask(req(`/api/opening/tasks/${id}`, "PATCH",
      { notBefore: "2026-10-16T00:00:00.000Z", expectedVersion: 2 }, owner.cookie), params(id));
    expect(deferDone.status).toBe(409);

    const foreign = await newTask({}, other.cookie);
    const foreignId = foreign.body.id as string;
    const cross = await patchTask(req(`/api/opening/tasks/${foreignId}`, "PATCH",
      { notBefore: "2026-10-16T00:00:00.000Z", expectedVersion: 1 }, owner.cookie), params(foreignId));
    expect(cross.status).toBe(404);
  });

  it("saves optional reasons through PATCH and rejects forged metadata without a mutation", async () => {
    const created = await newTask(), id = created.body.id as string;
    const path = `/api/opening/tasks/${id}`;
    for (const feedback of [{ reason: "correct" }, { reason: "other", origin: "planner" }, { reason: "other", text: "private" }]) {
      const response = await patchTask(req(path, "PATCH", { status: "skipped", expectedVersion: 1,
        at: new Date().toISOString(), feedback }, owner.cookie), params(id));
      expect(response.status).toBe(400);
    }
    const response = await patchTask(req(path, "PATCH", { status: "skipped", expectedVersion: 1,
      at: new Date().toISOString(), feedback: { reason: "too_hard" } }, owner.cookie), params(id));
    expect(response.status).toBe(200);
    expect(await sql`SELECT action, reason, origin, task_version FROM opening_plan_feedback WHERE task_id=${id}`)
      .toEqual([{ action: "skipped", reason: "too_hard", origin: "manual", task_version: 2 }]);
  });

  it("authenticates and bounds the read-only feedback window with no model or plan writes", async () => {
    const anonymous = await getFeedback(req("/api/opening/plans/feedback", "GET", undefined, ""));
    expect(anonymous.status).toBe(401);
    for (const days of [0, 91, "NaN", 1.5]) {
      expect((await getFeedback(req(`/api/opening/plans/feedback?days=${days}`, "GET", undefined, owner.cookie))).status).toBe(400);
    }
    const response = await getFeedback(req("/api/opening/plans/feedback?days=7", "GET", undefined, owner.cookie));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ actions: { done: 0, skipped: 0, deferred: 0, resumed: 0 },
      reasons: { eligible: 0, coverage: null }, historicalActions: "unknown" });
    expect(await sql`SELECT id FROM opening_plan_drafts WHERE workspace_id=${owner.scope.workspaceId}`).toHaveLength(0);
    expect(await sql`SELECT id FROM opening_plan_feedback WHERE workspace_id=${owner.scope.workspaceId}`).toHaveLength(0);
  });

  it("reads default prefs, merges patches and removes a course goal", async () => {
    const initial = await (await getPrefs(req("/api/opening/adaptive-planning", "GET", undefined, owner.cookie))).json();
    expect(initial).toEqual({
      prefs: { autonomy: "copilot", coachBudgetMinutes: 60, courseGoals: {} }, saved: false, invalidStoredPrefs: false,
    });

    const courseId = await createCourse(owner.scope);
    await patchPrefs(req("/api/opening/adaptive-planning", "PATCH", { autonomy: "coach" }, owner.cookie));
    const withGoal = await patchPrefs(req("/api/opening/adaptive-planning", "PATCH",
      { courseGoal: { courseId, goal: { targetDate: "2026-11-01", weeklyMinutes: 300 } } }, owner.cookie));
    expect(await withGoal.json()).toMatchObject({
      prefs: { autonomy: "coach", coachBudgetMinutes: 60, courseGoals: { [courseId]: { targetDate: "2026-11-01", weeklyMinutes: 300 } } },
      saved: true,
    });

    const removed = await patchPrefs(req("/api/opening/adaptive-planning", "PATCH",
      { courseGoal: { courseId, goal: null } }, owner.cookie));
    expect((await removed.json() as { prefs: { courseGoals: object } }).prefs.courseGoals).toEqual({});
  });

  it("rejects a goal for a course outside the workspace and reports unreadable stored prefs", async () => {
    const foreignCourse = await createCourse(other.scope);
    const response = await patchPrefs(req("/api/opening/adaptive-planning", "PATCH",
      { courseGoal: { courseId: foreignCourse, goal: { targetDate: null, weeklyMinutes: 60 } } }, owner.cookie));
    expect(response.status).toBe(404);

    await sql`INSERT INTO workspace_preferences (workspace_id, adaptive_planning)
      VALUES (${owner.scope.workspaceId}, ${sql.json({ autonomy: "turbo" } as never)})
      ON CONFLICT (workspace_id) DO UPDATE SET adaptive_planning = EXCLUDED.adaptive_planning`;
    const read = await (await getPrefs(req("/api/opening/adaptive-planning", "GET", undefined, owner.cookie))).json();
    expect(read).toMatchObject({ prefs: { autonomy: "copilot" }, saved: true, invalidStoredPrefs: true });
  });
});
