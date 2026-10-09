import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, createSqlClient } from "@aistudy/database";
import { GET as listTasks, POST as createTask } from "../../../apps/web/src/app/api/opening/tasks/route";
import { POST as proposePlan } from "../../../apps/web/src/app/api/opening/plans/route";
import { POST as acceptPlan } from "../../../apps/web/src/app/api/opening/plans/[id]/accept/route";
import { POST as rejectPlan } from "../../../apps/web/src/app/api/opening/plans/[id]/reject/route";
import { GET as getToday } from "../../../apps/web/src/app/api/opening/today/route";
import { POST as register } from "../../../apps/web/src/app/api/auth/register/route";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for plan handler tests");

const cookieName = "aistudy_session";
const sql = createSqlClient(databaseUrl);
let runtime: ReturnType<typeof createAuthRuntime> | undefined;
let cookie: string;

const day = "2026-09-14";
const at = (clock: string) => `2026-09-14T${clock}:00.000Z`;

function req(path: string, method = "GET", body?: unknown, authCookie = cookie) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      ...(authCookie ? { cookie: authCookie } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function registerUser(label: string): Promise<string> {
  const response = await register(
    new Request("http://localhost/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: `${label}-${randomUUID()}@example.com`,
        password: "password123",
        displayName: label,
      }),
    }),
  );
  expect(response.status).toBe(201);
  return `${cookieName}=${response.headers.get("set-cookie")!.match(/aistudy_session=([^;]+)/)![1]}`;
}

beforeAll(async () => {
  await applyMigrations(sql);
  runtime = createAuthRuntime({
    databaseUrl,
    authSecret: "opening-plans-handler-secret-32chars!",
    sessionCookieSecure: false,
    sessionTtlSeconds: 3600,
    authCookieName: cookieName,
  });
  setAuthRuntimeForTests(runtime);
  cookie = await registerUser("planner");
});

beforeEach(async () => {
  await sql`TRUNCATE opening_plan_acceptances, opening_plan_drafts, opening_plan_state, opening_hard_blocks, opening_timetable_sessions, opening_tasks RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  setAuthRuntimeForTests(null);
  await runtime?.close();
  await sql.end({ timeout: 5 });
});

describe("opening plans handlers (P02)", () => {
  it("returns 401 without a session", async () => {
    const response = await listTasks(req("/api/opening/tasks", "GET", undefined, ""));
    expect(response.status).toBe(401);
  });

  it("rejects dueText+dueAt as formal deadline forgery", async () => {
    const response = await createTask(
      req("/api/opening/tasks", "POST", {
        title: "作业",
        minutes: 30,
        dueAt: at("18:00"),
        dueText: "sometime soon",
        priority: 1,
        candidateId: null,
      }),
    );
    expect(response.status).toBe(400);
  });

  it("keeps ambiguous dueText without dueAt", async () => {
    const response = await createTask(
      req("/api/opening/tasks", "POST", {
        title: "作业",
        minutes: 30,
        dueAt: null,
        dueText: "下周某天",
        priority: 1,
        candidateId: null,
      }),
    );
    expect(response.status).toBe(201);
    const task = await response.json();
    expect(task.dueAt).toBeNull();
  });

  it("proposes a draft with baseVersion snapshot; accept once; reject leaves plan", async () => {
    await createTask(
      req("/api/opening/tasks", "POST", {
        title: "物理作业",
        minutes: 30,
        dueAt: null,
        priority: 1,
        candidateId: null,
      }),
    );

    const free = [
      { start: at("08:00"), end: at("12:00"), kind: "free" },
      { start: at("08:00"), end: at("09:00"), kind: "sleep" },
    ];
    const proposed = await proposePlan(
      req("/api/opening/plans", "POST", { date: day, free, clientKey: "propose-key-01" }),
    );
    expect(proposed.status).toBe(201);
    const draft = await proposed.json();
    expect(draft.baseVersion).toBe(0);
    expect(draft.status).toBe("draft");
    expect(draft.blocks.length + draft.unscheduledTaskIds.length).toBeGreaterThan(0);

    const accepted = await acceptPlan(
      req(`/api/opening/plans/${draft.id}/accept`, "POST", {
        expectedBaseVersion: 0,
        clientKey: "accept-key-001",
      }),
      { params: Promise.resolve({ id: draft.id }) },
    );
    expect(accepted.status).toBe(200);
    const acceptedBody = await accepted.json();
    expect(acceptedBody.status).toBe("accepted");
    expect(acceptedBody.version).toBe(1);

    const today = await getToday(req(`/api/opening/today?date=${day}`));
    expect(today.status).toBe(200);
    const todayBody = await today.json();
    expect(todayBody.acceptedVersion).toBe(1);

    // second draft then reject — current accepted plan unchanged
    const draft2Res = await proposePlan(
      req("/api/opening/plans", "POST", { date: day, free, clientKey: "propose-key-02" }),
    );
    const draft2 = await draft2Res.json();
    expect(draft2.baseVersion).toBe(1);
    const rejected = await rejectPlan(
      req(`/api/opening/plans/${draft2.id}/reject`, "POST", {}),
      { params: Promise.resolve({ id: draft2.id }) },
    );
    expect(rejected.status).toBe(200);
    const todayAfter = await (await getToday(req(`/api/opening/today?date=${day}`))).json();
    expect(todayAfter.acceptedVersion).toBe(1);
  });

  it("stale accept returns 409; clientKey replay is idempotent; changed payload conflicts", async () => {
    await createTask(
      req("/api/opening/tasks", "POST", {
        title: "数学",
        minutes: 30,
        dueAt: null,
        priority: 1,
        candidateId: null,
      }),
    );
    const free = [{ start: at("09:00"), end: at("11:00"), kind: "free" }];
    const d1 = await (await proposePlan(req("/api/opening/plans", "POST", { date: day, free }))).json();
    await acceptPlan(
      req(`/api/opening/plans/${d1.id}/accept`, "POST", {
        expectedBaseVersion: 0,
        clientKey: "accept-idem-001",
      }),
      { params: Promise.resolve({ id: d1.id }) },
    );

    const d2 = await (await proposePlan(req("/api/opening/plans", "POST", { date: day, free }))).json();
    const stale = await acceptPlan(
      req(`/api/opening/plans/${d2.id}/accept`, "POST", {
        expectedBaseVersion: 0,
        clientKey: "accept-stale-001",
      }),
      { params: Promise.resolve({ id: d2.id }) },
    );
    expect(stale.status).toBe(409);

    const replay = await acceptPlan(
      req(`/api/opening/plans/${d1.id}/accept`, "POST", {
        expectedBaseVersion: 0,
        clientKey: "accept-idem-001",
      }),
      { params: Promise.resolve({ id: d1.id }) },
    );
    expect(replay.status).toBe(200);

    const conflict = await acceptPlan(
      req(`/api/opening/plans/${d2.id}/accept`, "POST", {
        expectedBaseVersion: 1,
        clientKey: "accept-idem-001",
      }),
      { params: Promise.resolve({ id: d2.id }) },
    );
    expect(conflict.status).toBe(409);
  });

  it("new hard block fingerprint invalidates stale draft on accept", async () => {
    await createTask(
      req("/api/opening/tasks", "POST", {
        title: "英语",
        minutes: 30,
        dueAt: null,
        priority: 1,
        candidateId: null,
      }),
    );
    const free1 = [{ start: at("09:00"), end: at("12:00"), kind: "free" }];
    const draft = await (
      await proposePlan(req("/api/opening/plans", "POST", { date: day, free: free1 }))
    ).json();

    // Insert a class block after draft — fingerprint changes via another propose/upsert
    const free2 = [
      { start: at("09:00"), end: at("12:00"), kind: "free" },
      { start: at("10:00"), end: at("11:00"), kind: "class" },
    ];
    await proposePlan(req("/api/opening/plans", "POST", { date: day, free: free2 }));

    const stale = await acceptPlan(
      req(`/api/opening/plans/${draft.id}/accept`, "POST", {
        expectedBaseVersion: 0,
        clientKey: "accept-class-001",
      }),
      { params: Promise.resolve({ id: draft.id }) },
    );
    expect(stale.status).toBe(409);
  });
});

describe("opening task quick-add idempotency (DL5)", () => {
  it("replays the same clientKey for candidateId null and returns the same id", async () => {
    const body = {
      title: "快速添加",
      minutes: 25,
      dueAt: null,
      priority: 1,
      candidateId: null,
      clientKey: "quick-add-key-001",
    };
    const first = await createTask(req("/api/opening/tasks", "POST", body));
    expect(first.status).toBe(201);
    const created = await first.json();

    const second = await createTask(req("/api/opening/tasks", "POST", body));
    expect(second.status).toBe(201);
    const replayed = await second.json();
    expect(replayed.id).toBe(created.id);

    const listed = await listTasks(req("/api/opening/tasks"));
    expect(listed.status).toBe(200);
    const { tasks } = await listed.json();
    expect(tasks.filter((task: { title: string }) => task.title === "快速添加")).toHaveLength(1);
  });

  it("creates two rows for different clientKeys", async () => {
    const base = {
      title: "不同键",
      minutes: 25,
      dueAt: null,
      priority: 1,
      candidateId: null,
    };
    const a = await createTask(req("/api/opening/tasks", "POST", { ...base, clientKey: "quick-add-key-a1" }));
    const b = await createTask(req("/api/opening/tasks", "POST", { ...base, clientKey: "quick-add-key-b2" }));
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const taskA = await a.json();
    const taskB = await b.json();
    expect(taskA.id).not.toBe(taskB.id);

    const listed = await listTasks(req("/api/opening/tasks"));
    const { tasks } = await listed.json();
    expect(tasks.filter((task: { title: string }) => task.title === "不同键")).toHaveLength(2);
  });

  it("conflicts when the same clientKey carries a different payload", async () => {
    const key = "quick-add-key-conflict";
    const first = await createTask(
      req("/api/opening/tasks", "POST", {
        title: "原标题",
        minutes: 25,
        dueAt: null,
        priority: 1,
        candidateId: null,
        clientKey: key,
      }),
    );
    expect(first.status).toBe(201);

    const second = await createTask(
      req("/api/opening/tasks", "POST", {
        title: "改过的标题",
        minutes: 25,
        dueAt: null,
        priority: 1,
        candidateId: null,
        clientKey: key,
      }),
    );
    expect(second.status).toBe(409);
  });

  it("isolates the same clientKey across owners", async () => {
    const otherCookie = await registerUser("other-quick-add");
    const body = {
      title: "跨用户",
      minutes: 15,
      dueAt: null,
      priority: 1,
      candidateId: null,
      clientKey: "quick-add-shared-key",
    };
    const mine = await createTask(req("/api/opening/tasks", "POST", body));
    const theirs = await createTask(req("/api/opening/tasks", "POST", body, otherCookie));
    expect(mine.status).toBe(201);
    expect(theirs.status).toBe(201);
    const myTask = await mine.json();
    const theirTask = await theirs.json();
    expect(myTask.id).not.toBe(theirTask.id);
  });
});
