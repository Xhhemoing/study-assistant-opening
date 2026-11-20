import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, createSqlClient } from "@aistudy/database";
import { deriveDayBlocks } from "@aistudy/domain";
import type { OpeningPlanningSettings } from "@aistudy/contracts";
import { GET as getPlanningSettings, PUT as putPlanningSettings } from "../../../apps/web/src/app/api/opening/planning-settings/route";
import { POST as proposePlan } from "../../../apps/web/src/app/api/opening/plans/route";
import { GET as getTimetable, PUT as putTimetable } from "../../../apps/web/src/app/api/opening/timetable/route";
import { POST as createTask } from "../../../apps/web/src/app/api/opening/tasks/route";
import { POST as register } from "../../../apps/web/src/app/api/auth/register/route";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for planning-settings handler tests");

const cookieName = "aistudy_session";
const sql = createSqlClient(databaseUrl);
let runtime: ReturnType<typeof createAuthRuntime> | undefined;
let cookie: string;
let otherCookie: string;

const settings: OpeningPlanningSettings = {
  weekOneMonday: "2024-09-02",
  periodTimes: {
    "1": { start: "08:00", end: "08:45" },
    "2": { start: "08:55", end: "09:40" },
  },
  dailyWindow: { start: "07:30", end: "22:30" },
  lunch: { start: "12:00", end: "13:00" },
  dinner: { start: "17:30", end: "18:30" },
  sleep: { start: "23:00", end: "07:00" },
  timeZone: "Asia/Shanghai",
};

const day = "2024-09-09"; // week-2 Monday

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
    authSecret: "opening-planning-settings-handler-32!",
    sessionCookieSecure: false,
    sessionTtlSeconds: 3600,
    authCookieName: cookieName,
  });
  setAuthRuntimeForTests(runtime);
  cookie = await registerUser("planner-settings");
  otherCookie = await registerUser("other-planner");
});

beforeEach(async () => {
  await sql`TRUNCATE opening_plan_acceptances, opening_plan_drafts, opening_plan_state, opening_hard_blocks, opening_timetable_sessions, opening_tasks RESTART IDENTITY CASCADE`;
  await sql`UPDATE workspace_preferences SET planning_settings = NULL`;
});

afterAll(async () => {
  setAuthRuntimeForTests(null);
  await runtime?.close();
  await sql.end({ timeout: 5 });
});

describe("opening planning-settings handlers (DL9)", () => {
  it("returns empty settings before save and persists for the owner only", async () => {
    const empty = await getPlanningSettings(req("/api/opening/planning-settings"));
    expect(empty.status).toBe(200);
    expect(empty.headers.get("cache-control")).toBe("no-store");
    expect(await empty.json()).toMatchObject({
      settings: null,
      saved: false,
      invalidStoredSettings: false,
    });

    const saved = await putPlanningSettings(req("/api/opening/planning-settings", "PUT", settings));
    expect(saved.status).toBe(200);
    const body = await saved.json();
    expect(body.saved).toBe(true);
    expect(body.settings).toMatchObject(settings);

    const other = await getPlanningSettings(
      req("/api/opening/planning-settings", "GET", undefined, otherCookie),
    );
    expect(other.status).toBe(200);
    expect(await other.json()).toMatchObject({ settings: null, saved: false });

    const foreignPut = await putPlanningSettings(
      req("/api/opening/planning-settings", "PUT", settings, otherCookie),
    );
    expect(foreignPut.status).toBe(200);
    // Owner row unchanged isolation: re-read owner still has original settings
    const ownerAgain = await (await getPlanningSettings(req("/api/opening/planning-settings"))).json();
    expect(ownerAgain.settings.weekOneMonday).toBe(settings.weekOneMonday);
  });

  it("rejects invalid planning settings bodies", async () => {
    const response = await putPlanningSettings(
      req("/api/opening/planning-settings", "PUT", {
        ...settings,
        lunch: { start: "12:00", end: "11:00" },
      }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("VALIDATION");
  });

  it("propose without free requires semester settings (VALIDATION)", async () => {
    await createTask(
      req("/api/opening/tasks", "POST", {
        title: "作业",
        minutes: 30,
        dueAt: null,
        priority: 1,
        candidateId: null,
      }),
    );
    const response = await proposePlan(req("/api/opening/plans", "POST", { date: day }));
    expect(response.status).toBe(400);
    const error = await response.json();
    expect(error.error.code).toBe("VALIDATION");
    expect(error.error.message).toMatch(/学期设置/);
  });

  it("propose without free matches explicit free derived from settings+timetable", async () => {
    await putPlanningSettings(req("/api/opening/planning-settings", "PUT", settings));
    await putTimetable(
      req("/api/opening/timetable", "PUT", {
        sessions: [
          {
            courseName: "数学I",
            weekday: 1,
            weeks: [2],
            startPeriod: 1,
            endPeriod: 2,
          },
        ],
      }),
    );
    await createTask(
      req("/api/opening/tasks", "POST", {
        title: "物理作业",
        minutes: 30,
        dueAt: null,
        priority: 1,
        candidateId: null,
      }),
    );

    const derived = deriveDayBlocks(day, settings, [
      { courseName: "数学I", weekday: 1, weeks: [2], startPeriod: 1, endPeriod: 2 },
    ]);

    const withFree = await proposePlan(
      req("/api/opening/plans", "POST", { date: day, free: derived, clientKey: "explicit-free-01" }),
    );
    expect(withFree.status).toBe(201);
    const explicitDraft = await withFree.json();

    // Clear drafts so the second propose is independent for comparison of blocks
    await sql`TRUNCATE opening_plan_acceptances, opening_plan_drafts, opening_plan_state, opening_hard_blocks RESTART IDENTITY CASCADE`;

    const withoutFree = await proposePlan(
      req("/api/opening/plans", "POST", { date: day, clientKey: "derived-free-01" }),
    );
    expect(withoutFree.status).toBe(201);
    const derivedDraft = await withoutFree.json();

    expect(derivedDraft.blocks).toEqual(explicitDraft.blocks);
    expect(derivedDraft.unscheduledTaskIds).toEqual(explicitDraft.unscheduledTaskIds);
  });

  it("allows only one replacement of a timetable revision, including the empty timetable", async () => {
    const path = "/api/opening/timetable";
    const snapshot = async () => (await getTimetable(req(path))).json();
    const replace = (courseName: string, expectedRevision: string) => putTimetable(req(path, "PUT", {
      sessions: [{ courseName, weekday: 1, weeks: [1], startPeriod: 1, endPeriod: 2 }], expectedRevision,
    }));
    const { revision } = await snapshot();
    const candidates = ["物理", "历史"];
    const results = await Promise.all(candidates.map(name => replace(name, revision)));
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
    const winner = candidates[results.findIndex(r => r.status === 200)]!;
    const current = await snapshot();
    expect(current.sessions).toMatchObject([{ courseName: winner }]);
    expect(current.revision).not.toBe(revision);

    expect((await replace("数学", current.revision)).status).toBe(200);
    expect((await replace(winner, current.revision)).status).toBe(409);
    expect((await snapshot()).sessions).toMatchObject([{ courseName: "数学" }]);
  });

  it("rejects an untouched preview after import and clear, and accepts the post-clear revision", async () => {
    const path = "/api/opening/timetable", freshCookie = await registerUser("clear-timetable");
    const snapshot = async () => (await getTimetable(req(path, "GET", undefined, freshCookie))).json();
    const sessions = [{ courseName: "物理", weekday: 1, weeks: [1], startPeriod: 1, endPeriod: 2 }];
    const put = (rows: typeof sessions, expectedRevision: string) =>
      putTimetable(req(path, "PUT", { sessions: rows, expectedRevision }, freshCookie));
    const initial = await snapshot();
    expect(initial).toEqual({ sessions: [], revision: expect.stringMatching(/^empty:[\da-f-]{36}$/i) });
    const other = await registerUser("other-untouched-timetable");
    const otherSnapshot = async () => (await getTimetable(req(path, "GET", undefined, other))).json();
    const untouched = await otherSnapshot();
    expect(untouched.sessions).toEqual([]);
    expect(untouched.revision).not.toBe(initial.revision);
    const foreign = await putTimetable(req(path, "PUT", { sessions, expectedRevision: initial.revision }, other));
    expect(foreign.status).toBe(409);
    expect((await foreign.json()).error.code).toBe("CONFLICT");
    expect(await otherSnapshot()).toEqual(untouched);
    expect((await put(sessions, initial.revision)).status).toBe(200);
    const imported = await snapshot();
    expect((await put([], imported.revision)).status).toBe(200);
    const cleared = await snapshot();
    expect(cleared).toEqual({ sessions: [], revision: expect.stringMatching(/^[\da-f-]{36}$/i) });
    expect(cleared.revision).not.toBe(imported.revision);
    const stale = await put(sessions, initial.revision);
    expect(stale.status).toBe(409);
    expect((await stale.json()).error.code).toBe("CONFLICT");
    expect(await snapshot()).toEqual(cleared);
    expect((await put([], cleared.revision)).status).toBe(200);
    const clearedAgain = await snapshot();
    expect(clearedAgain.revision).not.toBe(cleared.revision);
    expect((await put(sessions, clearedAgain.revision)).status).toBe(200);
  });

  it("requires authentication", async () => {
    expect((await getPlanningSettings(req("/api/opening/planning-settings", "GET", undefined, ""))).status).toBe(401);
    expect((await putPlanningSettings(req("/api/opening/planning-settings", "PUT", settings, ""))).status).toBe(401);
  });
});
