import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, createSqlClient } from "@aistudy/database";
import { POST as register } from "../../../apps/web/src/app/api/auth/register/route";
import { GET as getToday } from "../../../apps/web/src/app/api/opening/today/route";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { createTodayResumeReader } from "../../../apps/web/src/features/opening/planning/today-service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const sql = createSqlClient(databaseUrl);
let runtime: ReturnType<typeof createAuthRuntime> | undefined;
let cookie = "";
let owner = { workspaceId: "", ownerUserId: "" };
let other = { workspaceId: "", ownerUserId: "" };

async function registerUser(label: string) {
  const response = await register(new Request("http://localhost/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: `${label}-${randomUUID()}@example.com`,
      password: "password123",
      displayName: label,
    }),
  }));
  const body = await response.json() as { user: { id: string; workspaceId: string } };
  const token = response.headers.get("set-cookie")!.match(/aistudy_session=([^;]+)/)![1];
  return {
    cookie: `aistudy_session=${token}`,
    userId: body.user.id,
    workspaceId: body.user.workspaceId,
  };
}

beforeAll(async () => {
  await applyMigrations(sql);
  runtime = createAuthRuntime({
    databaseUrl,
    authSecret: "opening-today-read-secret-32bytes!",
    sessionCookieSecure: false,
    sessionTtlSeconds: 3600,
    authCookieName: "aistudy_session",
  });
  setAuthRuntimeForTests(runtime);
  const first = await registerUser("today-owner");
  const second = await registerUser("today-other");
  cookie = first.cookie;
  owner = { workspaceId: first.workspaceId, ownerUserId: first.userId };
  other = { workspaceId: second.workspaceId, ownerUserId: second.userId };
});

afterAll(async () => {
  setAuthRuntimeForTests(null);
  await runtime?.close();
  await sql.end({ timeout: 5 });
});

describe("owner today resume read", () => {
  it("returns the owner's latest user turn and ignores another owner's rows", async () => {
    const courseId = randomUUID();
    const sourceId = randomUUID();
    const conversationId = randomUUID();
    const turnId = randomUUID();
    await sql`INSERT INTO courses (id, workspace_id, title, slug)
      VALUES (${courseId}, ${owner.workspaceId}, 'Algebra', ${`alg-${courseId.slice(0, 8)}`})`;
    await sql`INSERT INTO opening_conversations (
      id, workspace_id, owner_user_id, title, course_id, updated_at
    ) VALUES (
      ${conversationId}, ${owner.workspaceId}, ${owner.ownerUserId}, '线性代数', ${courseId}, now()
    )`;
    await sql`INSERT INTO opening_turns (
      id, workspace_id, conversation_id, role, text, mode, status,
      current_page, source_ids, source_versions, citations
    ) VALUES (
      ${turnId}, ${owner.workspaceId}, ${conversationId}, 'user', '如何判断矩阵可逆？',
      'explain', 'complete', 7, ${sql.array([] as string[])}::uuid[],
      ${sql.json({ [sourceId]: 4 } as never)}, ${sql.json([] as never)}
    )`;
    const foreignConversation = randomUUID();
    await sql`INSERT INTO opening_conversations (
      id, workspace_id, owner_user_id, title, updated_at
    ) VALUES (
      ${foreignConversation}, ${other.workspaceId}, ${other.ownerUserId}, '别人的会话', now()
    )`;

    const reader = createTodayResumeReader(sql);
    const latest = await reader.latestOwned(owner);
    expect(latest).toMatchObject({
      id: conversationId,
      courseId,
      lastUserText: "如何判断矩阵可逆？",
      currentPage: 7,
      sourceVersions: { [sourceId]: 4 },
    });
    await expect(reader.latestOwned(other)).resolves.toMatchObject({ id: foreignConversation });
    await expect(reader.latestOwned({
      workspaceId: owner.workspaceId,
      ownerUserId: other.ownerUserId,
    })).resolves.toBeNull();
  });

  it("counts only pending candidates owned through the conversation", async () => {
    const conversationId = randomUUID();
    const turnId = randomUUID();
    const candidateId = randomUUID();
    await sql`INSERT INTO opening_conversations (id, workspace_id, owner_user_id, title)
      VALUES (${conversationId}, ${owner.workspaceId}, ${owner.ownerUserId}, '待确认')`;
    await sql`INSERT INTO opening_turns (
      id, workspace_id, conversation_id, role, text, mode, status, source_ids, citations
    ) VALUES (
      ${turnId}, ${owner.workspaceId}, ${conversationId}, 'assistant', '候选',
      'explain', 'complete', ${sql.array([] as string[])}::uuid[], ${sql.json([] as never)}
    )`;
    await sql`INSERT INTO opening_assistant_candidates (
      id, workspace_id, conversation_id, source_turn_id, source_ids, payload, status
    ) VALUES (
      ${candidateId}, ${owner.workspaceId}, ${conversationId}, ${turnId},
      ${sql.json([] as never)}, ${sql.json({ kind: "memory", text: "事实", temporary: false } as never)},
      'pending'
    )`;
    const reader = createTodayResumeReader(sql);
    await expect(reader.pendingCandidateCount(owner)).resolves.toBeGreaterThan(0);
    await expect(reader.pendingCandidateCount({
      workspaceId: owner.workspaceId,
      ownerUserId: other.ownerUserId,
    })).resolves.toBe(0);
  });
});

describe("GET /api/opening/today", () => {
  it("requires an ISO date and the signed-in owner plan", async () => {
    const missing = await getToday(new Request("http://localhost/api/opening/today", {
      headers: { cookie },
    }));
    expect(missing.status).toBe(422);

    const today = await getToday(new Request("http://localhost/api/opening/today?date=2026-09-21", {
      headers: { cookie },
    }));
    expect(today.status).toBe(200);
    await expect(today.json()).resolves.toMatchObject({
      date: "2026-09-21",
      acceptedVersion: 0,
    });

    const anonymous = await getToday(new Request("http://localhost/api/opening/today?date=2026-09-21"));
    expect(anonymous.status).toBe(401);
  });
});
