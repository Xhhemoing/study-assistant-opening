import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, createSqlClient } from "@aistudy/database";
import type { ConversationLearningPreview, Scope } from "@aistudy/contracts";
import { POST as register } from "../../../apps/web/src/app/api/auth/register/route";
import { POST as preview } from "../../../apps/web/src/app/api/opening/learning-agent/preview/route";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";

const databaseUrl = process.env.DATABASE_URL ?? "";
if (!databaseUrl) throw new Error("DATABASE_URL is required for conversation preview handler tests");
const sql = createSqlClient(databaseUrl);
let runtime: ReturnType<typeof createAuthRuntime> | undefined;
let owner: { scope: Scope; cookie: string };
let other: { scope: Scope; cookie: string };
const originalSwitch = process.env.OPENING_ADAPTIVE_PLANNING;
const message = "我十天后考试，矩阵乘法不太懂，每天晚上只有一小时，帮我安排一下，最好边讲边练。";

async function registerUser(name: string) {
  const response = await register(new Request("http://localhost/api/auth/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: name + "-" + randomUUID() + "@example.com",
      displayName: name, password: "password123" }),
  }));
  expect(response.status).toBe(201);
  const body = await response.json() as { user: { id: string; workspaceId: string } };
  const session = response.headers.get("set-cookie")!.match(/aistudy_session=([^;]+)/)![1]!;
  return { cookie: "aistudy_session=" + session,
    scope: { workspaceId: body.user.workspaceId, ownerUserId: body.user.id } };
}

async function createCourse(scope: Scope) {
  const courseId = randomUUID();
  await sql`INSERT INTO courses(id,workspace_id,title,slug)
    VALUES (${courseId}, ${scope.workspaceId}, '线性代数', ${'agent-preview-' + courseId})`;
  return courseId;
}

const req = (courseId: string, cookie?: string, extra: Record<string, unknown> = {}) =>
  new Request("http://localhost/api/opening/learning-agent/preview", {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ message, courseId, ...extra }),
  });

beforeAll(async () => {
  await applyMigrations(sql);
  runtime = createAuthRuntime({ databaseUrl,
    authSecret: "conversation-preview-integration-secret-123",
    sessionCookieSecure: false, sessionTtlSeconds: 3600, authCookieName: "aistudy_session" });
  setAuthRuntimeForTests(runtime);
  owner = await registerUser("conversation-owner");
  other = await registerUser("conversation-other");
});

beforeEach(() => { process.env.OPENING_ADAPTIVE_PLANNING = "1"; });

afterAll(async () => {
  if (originalSwitch === undefined) delete process.env.OPENING_ADAPTIVE_PLANNING;
  else process.env.OPENING_ADAPTIVE_PLANNING = originalSwitch;
  setAuthRuntimeForTests(null);
  await runtime?.close();
  await sql.end({ timeout: 5 });
});

describe("read-only conversation learning preview", () => {
  it("requires login and an owned course", async () => {
    const owned = await createCourse(owner.scope);
    expect((await preview(req(owned))).status).toBe(401);
    expect((await preview(req(owned, other.cookie))).status).toBe(404);
    expect((await preview(req(randomUUID(), owner.cookie))).status).toBe(404);
  });
  it("keeps rollout switched off by default and accepts only valid input", async () => {
    const owned = await createCourse(owner.scope);
    process.env.OPENING_ADAPTIVE_PLANNING = "0";
    expect((await preview(req(owned, owner.cookie))).status).toBe(404);
    process.env.OPENING_ADAPTIVE_PLANNING = "1";
    expect((await preview(req(owned, owner.cookie, { date: "invalid-date" }))).status).toBeGreaterThanOrEqual(400);
  });
  it("returns an idempotent diagnostic preview without saving tasks, drafts or mastery", async () => {
    const owned = await createCourse(owner.scope);
    const first = await preview(req(owned, owner.cookie));
    expect(first.status).toBe(200);
    expect(first.headers.get("Cache-Control")).toBe("no-store");
    const data = await first.json() as ConversationLearningPreview;
    expect(data).toMatchObject({
      policyVersion: "conversation-learning-v1", readOnly: true,
      diagnosis: { action: "diagnostic", masteryUpdated: false },
      plan: { isCommitted: false, status: "no_planning_settings" },
    });
    expect(data.intent).toMatchObject({ examInDays: 10, dailyMinutes: 60 });
    const second = await (await preview(req(owned, owner.cookie))).json() as ConversationLearningPreview;
    expect(second.plan.proposedTask.id).toBe(data.plan.proposedTask.id);
    const [tasks] = await sql`SELECT count(*)::int AS count FROM opening_tasks WHERE workspace_id=${owner.scope.workspaceId}`;
    const [drafts] = await sql`SELECT count(*)::int AS count FROM opening_plan_drafts WHERE workspace_id=${owner.scope.workspaceId}`;
    expect(Number(tasks.count)).toBe(0);
    expect(Number(drafts.count)).toBe(0);
  });
});
