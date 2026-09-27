import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, createSqlClient } from "@aistudy/database";
import { POST as register } from "../../../apps/web/src/app/api/auth/register/route";
import { POST as createTask } from "../../../apps/web/src/app/api/opening/tasks/route";
import { GET as listReminders, POST as enqueueReminders } from "../../../apps/web/src/app/api/opening/reminders/route";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for reminder handler tests");

const cookieName = "aistudy_session";
const sql = createSqlClient(databaseUrl);
let runtime: ReturnType<typeof createAuthRuntime> | undefined;
let cookie: string;
let otherCookie: string;

const pastDue = "2020-01-01T00:00:00.000Z";

function taskBody(title: string, clientKey: string) {
  return {
    title,
    minutes: 30,
    dueAt: pastDue,
    priority: 1,
    candidateId: null,
    clientKey,
  };
}

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
    authSecret: "opening-reminders-handler-secret-32ch",
    sessionCookieSecure: false,
    sessionTtlSeconds: 3600,
    authCookieName: cookieName,
  });
  setAuthRuntimeForTests(runtime);
  cookie = await registerUser("reminder-owner");
  otherCookie = await registerUser("reminder-other");
});

beforeEach(async () => {
  await sql`TRUNCATE opening_jobs, opening_tasks RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  setAuthRuntimeForTests(null);
  await runtime?.close();
  await sql.end({ timeout: 5 });
});

describe("opening reminder handlers (P03)", () => {
  it("returns 401 without a session", async () => {
    const response = await listReminders(req("/api/opening/reminders", "GET", undefined, ""));
    expect(response.status).toBe(401);
  });

  it("lists a due in-app item before enqueue and does not mark it sent", async () => {
    const created = await createTask(req("/api/opening/tasks", "POST", taskBody("物理作业", "task-key-0001")));
    expect(created.status).toBe(201);

    const listed = await listReminders(req("/api/opening/reminders"));
    expect(listed.status).toBe(200);
    const body = await listed.json() as {
      externalDelivery: string;
      reminders: Array<{ status: string; channel: string; receiptId: string | null; taskVersion: number; dueAt: string }>;
    };
    expect(body.externalDelivery).toBe("disabled");
    expect(body.reminders).toHaveLength(1);
    expect(body.reminders[0]).toMatchObject({
      status: "due",
      channel: "in_app",
      receiptId: null,
      taskVersion: 1,
      dueAt: pastDue,
    });
  });

  it("enqueues an idempotent in-app reminder and hides another owner's task", async () => {
    const ownerTask = await createTask(req("/api/opening/tasks", "POST", taskBody("物理作业", "task-key-0001")));
    const otherTask = await createTask(req("/api/opening/tasks", "POST", taskBody("别人的作业", "task-key-0002"), otherCookie));
    expect(ownerTask.status).toBe(201);
    expect(otherTask.status).toBe(201);

    const first = await enqueueReminders(req("/api/opening/reminders", "POST", {
      clientKey: "remind-key-01",
    }));
    const second = await enqueueReminders(req("/api/opening/reminders", "POST", {
      clientKey: "remind-key-01",
    }));
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    const queued = await first.json() as { reminders: Array<{ status: string; receiptId: null }> };
    expect(queued.reminders).toHaveLength(1);
    expect(queued.reminders[0]).toMatchObject({ status: "due", receiptId: null });

    const jobs = await sql`SELECT id FROM opening_jobs WHERE kind = 'remind' AND key <> 'remind-external-config'`;
    expect(jobs).toHaveLength(1);

    const other = await listReminders(req("/api/opening/reminders", "GET", undefined, otherCookie));
    const otherBody = await other.json() as { reminders: unknown[] };
    expect(otherBody.reminders).toHaveLength(1);
    const owner = await listReminders(req("/api/opening/reminders"));
    const ownerBody = await owner.json() as { reminders: unknown[] };
    expect(ownerBody.reminders).toHaveLength(1);
  });

  it("returns 422 when feishu is requested without configuration", async () => {
    const created = await createTask(req("/api/opening/tasks", "POST", taskBody("物理作业", "task-key-0001")));
    expect(created.status).toBe(201);
    const response = await enqueueReminders(req("/api/opening/reminders", "POST", {
      clientKey: "remind-key-01",
      channel: "feishu",
    }));
    expect(response.status).toBe(422);
    const jobs = await sql`SELECT id FROM opening_jobs WHERE kind = 'remind'`;
    expect(jobs).toHaveLength(0);
  });
});
