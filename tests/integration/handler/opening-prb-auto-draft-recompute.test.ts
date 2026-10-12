import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, createSqlClient } from "@aistudy/database";
import type { OpeningPlanningSettings } from "@aistudy/contracts";
import { GET as getToday } from "../../../apps/web/src/app/api/opening/today/route";
import { POST as createTask } from "../../../apps/web/src/app/api/opening/tasks/route";
import { POST as acceptPlan } from "../../../apps/web/src/app/api/opening/plans/[id]/accept/route";
import { POST as rejectPlan } from "../../../apps/web/src/app/api/opening/plans/[id]/reject/route";
import { PUT as putPlanningSettings } from "../../../apps/web/src/app/api/opening/planning-settings/route";
import { POST as register } from "../../../apps/web/src/app/api/auth/register/route";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for PR-B auto-draft recompute tests");

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

async function seedTask(title = "ç‰©ç†ä½œä¸š") {
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
    authSecret: "opening-prb-recompute-handler-secret32!",
    sessionCookieSecure: false,
    sessionTtlSeconds: 3600,
    authCookieName: cookieName,
  });
  setAuthRuntimeForTests(runtime);
  cookie = await registerUser("prb-recompute");
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

const autoKey = `auto-draft:${day}`;

async function workspaceScope() {
  const rows = await sql`SELECT s.user_id, w.id AS workspace_id FROM sessions s JOIN workspaces w ON w.owner_user_id = s.user_id
    ORDER BY s.created_at DESC LIMIT 1`;
  return { workspaceId: String(rows[0]!.workspace_id), ownerUserId: String(rows[0]!.user_id) };
}

async function draftRows() {
  return sql`SELECT id, status, input_snapshot FROM opening_plan_drafts WHERE day = ${day}::date AND propose_client_key = ${autoKey}
    ORDER BY created_at, id`;
}

describe("PR-B: unconfirmed auto draft recompute", () => {
  it("a pre-fix stale draft is superseded once; two concurrent opens leave exactly one live draft", async () => {
    await putPlanningSettings(req("/api/opening/planning-settings", "PUT", settings));
    await seedTask();
    const scope = await workspaceScope();
    const staleId = randomUUID();
    // Simulates a draft persisted before the local-day fix: no algo marker, empty blocks.
    await sql`INSERT INTO opening_plan_drafts (id, workspace_id, owner_user_id, day, version, base_version, status,
        blocks, unscheduled_task_ids, input_snapshot, hard_blocks_fingerprint, propose_client_key)
      VALUES (${staleId}, ${scope.workspaceId}, ${scope.ownerUserId}, ${day}::date, 0, 0, 'draft',
        '[]'::jsonb, '[]'::jsonb, ${sql.json({ tasks: [], free: [], autoDraft: true } as never)}, 'stale', ${autoKey})`;

    const [a, b] = await Promise.all([
      getToday(req(`/api/opening/today?date=${day}`)),
      getToday(req(`/api/opening/today?date=${day}`)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const [ba, bb] = [await a.json(), await b.json()];
    expect(ba.dailyDraft.id).toBe(bb.dailyDraft.id);
    expect(ba.dailyDraft.id).not.toBe(staleId);
    expect(ba.dailyDraft.blocks.length).toBe(1);

    const rows = await draftRows();
    const live = rows.filter((r) => r.status === "draft");
    expect(live).toHaveLength(1);
    const stale = rows.find((r) => r.id === staleId)!;
    expect(stale.status).toBe("rejected");
    expect((stale.input_snapshot as Record<string, unknown>).supersededBy).toBe(live[0]!.id);
    expect(rows).toHaveLength(2);

    // Unchanged inputs: stable id, no new rows.
    const again = await (await getToday(req(`/api/opening/today?date=${day}`))).json();
    expect(again.dailyDraft.id).toBe(live[0]!.id);
    expect(await draftRows()).toHaveLength(2);
  });

  it("changed inputs recompute; concurrent opens still produce one live draft", async () => {
    await putPlanningSettings(req("/api/opening/planning-settings", "PUT", settings));
    await seedTask("first");
    const first = await (await getToday(req(`/api/opening/today?date=${day}`))).json();
    await seedTask("second");
    const results = await Promise.all(Array.from({ length: 4 }, () => getToday(req(`/api/opening/today?date=${day}`))));
    const bodies = await Promise.all(results.map((r) => r.json()));
    const ids = new Set(bodies.map((x) => x.dailyDraft.id));
    expect(ids.size).toBe(1);
    expect(ids.has(first.dailyDraft.id)).toBe(false);
    expect(bodies[0].dailyDraft.blocks.length).toBe(2);
    const rows = await draftRows();
    expect(rows.filter((r) => r.status === "draft")).toHaveLength(1);
    expect(rows.find((r) => r.id === first.dailyDraft.id)?.status).toBe("rejected");
  });

  it("accepted plan is never recomputed by later opens", async () => {
    await putPlanningSettings(req("/api/opening/planning-settings", "PUT", settings));
    await seedTask("accepted-one");
    const body = await (await getToday(req(`/api/opening/today?date=${day}`))).json();
    const draft = body.dailyDraft;
    const accepted = await acceptPlan(
      req(`/api/opening/plans/${draft.id}/accept`, "POST", { expectedBaseVersion: draft.baseVersion, clientKey: `accept-${draft.id}` }),
      { params: Promise.resolve({ id: draft.id }) },
    );
    expect(accepted.status).toBe(200);
    const before = await sql`SELECT accepted_version, accepted_blocks FROM opening_plan_state WHERE day = ${day}::date`;
    await seedTask("added-after-accept");
    const [x, y] = await Promise.all([getToday(req(`/api/opening/today?date=${day}`)), getToday(req(`/api/opening/today?date=${day}`))]);
    for (const r of [await x.json(), await y.json()]) {
      expect(r.dailyDraft).toBeNull();
      expect(r.dailyDraftSkippedReason).toBe("accepted");
    }
    const after = await sql`SELECT accepted_version, accepted_blocks FROM opening_plan_state WHERE day = ${day}::date`;
    expect(after).toEqual(before);
    const rows = await draftRows();
    expect(rows.filter((r) => r.status === "draft")).toHaveLength(0);
    expect(rows.find((r) => r.id === draft.id)?.status).toBe("accepted");
  });

  it("a user-rejected auto draft stays rejected (not recomputed)", async () => {
    await putPlanningSettings(req("/api/opening/planning-settings", "PUT", settings));
    await seedTask("to-reject");
    const body = await (await getToday(req(`/api/opening/today?date=${day}`))).json();
    const rejected = await rejectPlan(req(`/api/opening/plans/${body.dailyDraft.id}/reject`, "POST", {}), { params: Promise.resolve({ id: body.dailyDraft.id }) });
    expect(rejected.status).toBeLessThan(300);
    await seedTask("after-reject");
    const next = await (await getToday(req(`/api/opening/today?date=${day}`))).json();
    expect(next.dailyDraft).toBeNull();
    expect(next.dailyDraftSkippedReason).toBe("rejected");
  });
});