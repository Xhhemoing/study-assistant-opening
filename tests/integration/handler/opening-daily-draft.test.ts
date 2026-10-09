import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, createSqlClient } from "@aistudy/database";
import type { OpeningPlanningSettings } from "@aistudy/contracts";
import { GET as getToday } from "../../../apps/web/src/app/api/opening/today/route";
import { POST as createTask } from "../../../apps/web/src/app/api/opening/tasks/route";
import { POST as proposePlan } from "../../../apps/web/src/app/api/opening/plans/route";
import { POST as acceptPlan } from "../../../apps/web/src/app/api/opening/plans/[id]/accept/route";
import { POST as rejectPlan } from "../../../apps/web/src/app/api/opening/plans/[id]/reject/route";
import { PUT as putPlanningSettings } from "../../../apps/web/src/app/api/opening/planning-settings/route";
import { POST as register } from "../../../apps/web/src/app/api/auth/register/route";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for daily-draft handler tests");

const cookieName = "aistudy_session";
const sql = createSqlClient(databaseUrl);
let runtime: ReturnType<typeof createAuthRuntime> | undefined;
let cookie: string;

const day = "2026-09-14";
const settings: OpeningPlanningSettings = {
  weekOneMonday: "2026-09-07",
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

async function seedTask(title = "物理作业") {
  const response = await createTask(
    req("/api/opening/tasks", "POST", {
      title,
      minutes: 30,
      dueAt: null,
      priority: 1,
      candidateId: null,
    }),
  );
  expect(response.status).toBe(201);
  return response.json();
}

beforeAll(async () => {
  await applyMigrations(sql);
  runtime = createAuthRuntime({
    databaseUrl,
    authSecret: "opening-daily-draft-handler-secret32!",
    sessionCookieSecure: false,
    sessionTtlSeconds: 3600,
    authCookieName: cookieName,
  });
  setAuthRuntimeForTests(runtime);
  cookie = await registerUser("daily-draft");
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

describe("opening daily auto-draft (P04a)", () => {
  it("two opens of today the same day produce one auto-draft", async () => {
    await putPlanningSettings(req("/api/opening/planning-settings", "PUT", settings));
    await seedTask();

    const first = await getToday(req(`/api/opening/today?date=${day}`));
    expect(first.status).toBe(200);
    const body1 = await first.json();
    expect(body1.dailyDraft).toMatchObject({
      date: day,
      status: "draft",
    });
    expect(body1.dailyDraftSkippedReason).toBeNull();
    const draftId = body1.dailyDraft.id as string;

    const second = await getToday(req(`/api/opening/today?date=${day}`));
    expect(second.status).toBe(200);
    const body2 = await second.json();
    expect(body2.dailyDraft.id).toBe(draftId);

    const rows = await sql`
      SELECT id FROM opening_plan_drafts
      WHERE day = ${day}::date AND propose_client_key = ${`auto-draft:${day}`}`;
    expect(rows).toHaveLength(1);
  });

  it("accepted plan skips auto-draft and reports unplanned pending count", async () => {
    await putPlanningSettings(req("/api/opening/planning-settings", "PUT", settings));
    await seedTask("已排");
    await seedTask("未排");

    const free = [
      {
        start: "2026-09-14T01:00:00.000Z",
        end: "2026-09-14T01:30:00.000Z",
        kind: "free" as const,
      },
    ];
    const proposed = await (
      await proposePlan(req("/api/opening/plans", "POST", { date: day, free, clientKey: "manual-propose-01" }))
    ).json();
    const accepted = await acceptPlan(
      req(`/api/opening/plans/${proposed.id}/accept`, "POST", {
        expectedBaseVersion: 0,
        clientKey: "accept-daily-01",
      }),
      { params: Promise.resolve({ id: proposed.id }) },
    );
    expect(accepted.status).toBe(200);

    const today = await getToday(req(`/api/opening/today?date=${day}`));
    expect(today.status).toBe(200);
    const body = await today.json();
    expect(body.acceptedVersion).toBe(1);
    expect(body.dailyDraft).toBeNull();
    expect(body.dailyDraftSkippedReason).toBe("accepted");
    expect(body.unplannedPendingCount).toBeGreaterThanOrEqual(0);

    const autoRows = await sql`
      SELECT id FROM opening_plan_drafts
      WHERE day = ${day}::date AND propose_client_key = ${`auto-draft:${day}`}`;
    expect(autoRows).toHaveLength(0);
  });

  it("concurrent today opens create only one auto-draft", async () => {
    await putPlanningSettings(req("/api/opening/planning-settings", "PUT", settings));
    await seedTask();

    const [a, b] = await Promise.all([
      getToday(req(`/api/opening/today?date=${day}`)),
      getToday(req(`/api/opening/today?date=${day}`)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const bodyA = await a.json();
    const bodyB = await b.json();
    expect(bodyA.dailyDraft.id).toBe(bodyB.dailyDraft.id);

    const rows = await sql`
      SELECT id FROM opening_plan_drafts
      WHERE day = ${day}::date AND propose_client_key = ${`auto-draft:${day}`}`;
    expect(rows).toHaveLength(1);
  });

  it("rejecting the auto-draft prevents recreate the same day", async () => {
    await putPlanningSettings(req("/api/opening/planning-settings", "PUT", settings));
    await seedTask();

    const first = await (await getToday(req(`/api/opening/today?date=${day}`))).json();
    const draftId = first.dailyDraft.id as string;
    expect(first.dailyDraft.status).toBe("draft");

    const rejected = await rejectPlan(
      req(`/api/opening/plans/${draftId}/reject`, "POST", {}),
      { params: Promise.resolve({ id: draftId }) },
    );
    expect(rejected.status).toBe(200);

    const second = await (await getToday(req(`/api/opening/today?date=${day}`))).json();
    expect(second.dailyDraft).toBeNull();
    expect(second.dailyDraftSkippedReason).toBe("rejected");

    const rows = await sql`
      SELECT id, status FROM opening_plan_drafts
      WHERE day = ${day}::date AND propose_client_key = ${`auto-draft:${day}`}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("rejected");
  });

  it("without planning settings, today does not 500 and skips auto-draft", async () => {
    await seedTask();
    const today = await getToday(req(`/api/opening/today?date=${day}`));
    expect(today.status).toBe(200);
    const body = await today.json();
    expect(body.dailyDraft).toBeNull();
    expect(body.dailyDraftSkippedReason).toBe("no_settings");
  });
});
