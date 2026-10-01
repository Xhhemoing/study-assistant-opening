import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, createSqlClient, createOpeningSourceActionsRepository } from "@aistudy/database";
import { POST as register } from "../../../apps/web/src/app/api/auth/register/route";
import { GET as resumeConversation } from "../../../apps/web/src/app/api/opening/conversations/[id]/resume/route";
import { GET as getToday } from "../../../apps/web/src/app/api/opening/today/route";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { createTodayResumeReader, loadTodayResumeState } from "../../../apps/web/src/features/opening/planning/today-service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";

const databaseUrl = process.env.DATABASE_URL ?? "";
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

const sourceKeys = { stagingKey: (id: string) => `opening/sources/${id}/staging`, finalKey: (id: string, version: number) => `opening/sources/${id}/${version}` };
async function material(scope = owner, page = 7) {
  const id = randomUUID();
  await sql`INSERT INTO opening_sources(id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state)
    VALUES(${id},${scope.workspaceId},'today.pdf','application/pdf',1,${"a".repeat(64)},4,'uploaded','ready')`;
  await sql`INSERT INTO opening_source_versions(source_id,workspace_id,version,bytes,sha256,availability)
    VALUES(${id},${scope.workspaceId},4,1,${"a".repeat(64)},'available')`;
  await sql`INSERT INTO opening_source_chunks(id,source_id,source_version,page,text)
    VALUES(${randomUUID()},${id},4,${page},'material page')`;
  return id;
}
async function savedConversation(sourceIds: string[], currentPage: number | null = 7, chunkId: string | null = null) {
  const conversationId = randomUUID(), turnId = randomUUID();
  await sql`INSERT INTO opening_conversations(id,workspace_id,owner_user_id,title)
    VALUES(${conversationId},${owner.workspaceId},${owner.ownerUserId},'Keep my conversation')`;
  await sql`INSERT INTO opening_turns(id,workspace_id,conversation_id,role,text,mode,status,source_ids,source_versions,current_page,chunk_id,citations)
    VALUES(${turnId},${owner.workspaceId},${conversationId},'user','Keep my original question','explain','complete',${sourceIds},
      ${sql.json(Object.fromEntries(sourceIds.map(id => [id,4])))},${currentPage},${chunkId},'[]'::jsonb)`;
  return { conversationId, turnId };
}
async function latestState() {
  return loadTodayResumeState({ scope: owner, reader: createTodayResumeReader(sql) });
}
async function assertSavedConversationOpens(conversationId: string) {
  const response = await resumeConversation(new Request(`http://localhost/api/opening/conversations/${conversationId}/resume`, { headers: { cookie } }),
    { params: Promise.resolve({ id: conversationId }) });
  expect(response.status).toBe(200);
  const resume = await response.json();
  expect(resume.boundedHistory).toContainEqual({ role: "user", text: "Keep my original question", citations: [] });
  return resume;
}
describe("owner today resume read", () => {
  it("returns the owner's latest user turn and ignores another owner's rows", async () => {
    const courseId = randomUUID();
    const sourceId = await material();
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
      'explain', 'complete', 7, ${sql.array([sourceId])}::uuid[],
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
    // Legacy assistant turns have unknown provenance; only an explicit known lineage is visible.
    await expect(reader.pendingCandidateCount(owner)).resolves.toBe(0);
    await sql`UPDATE opening_turns SET context_source_refs='[]'::jsonb WHERE id=${turnId}`;
    await expect(reader.pendingCandidateCount(owner)).resolves.toBe(1);
    await expect(reader.pendingCandidates(owner)).resolves.toEqual([{ id: candidateId, payload: { kind: "memory", text: "事实", temporary: false } }]);
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

describe("Today recoverability after source changes", () => {
  it("removes deleted material and its location while keeping another material and the original conversation", async () => {
    const removedId = await material(), remainingId = await material();
    const chunks = await sql`SELECT id FROM opening_source_chunks WHERE source_id=${removedId}`;
    const { conversationId, turnId } = await savedConversation([removedId, remainingId], 7, String(chunks[0]!.id));
    expect((await latestState()).continueItem?.sourceVersions).toEqual({ [removedId]: 4, [remainingId]: 4 });
    await createOpeningSourceActionsRepository(sql).apply(owner, removedId,
      { action: "delete", expectedVersion: 4, expectedMembershipIds: [] }, sourceKeys, new Date());
    const state = await latestState();
    expect(state.continueItem).toMatchObject({ conversationId, lastUserText: "Keep my original question", currentPage: null, manualSourceCount: 0 });
    expect(state.continueItem?.sourceVersions).toEqual({ [remainingId]: 4 });
    const original = (await sql`SELECT text,source_versions,current_page FROM opening_turns WHERE id=${turnId}`)[0]!;
    expect(original).toMatchObject({ text: "Keep my original question", current_page: 7, source_versions: { [removedId]: 4, [remainingId]: 4 } });
    const resumed = await assertSavedConversationOpens(conversationId);
    expect(resumed.sourceIds).toEqual([remainingId]);
    expect(resumed.currentPage).toBeNull();
  });

  it("retains AI-excluded material only as a manual-reading hint", async () => {
    const sourceId = await material();
    const { conversationId } = await savedConversation([sourceId]);
    await createOpeningSourceActionsRepository(sql).apply(owner, sourceId,
      { action: "exclude", expectedVersion: 4, expectedMembershipIds: [] }, sourceKeys, new Date());
    const state = await latestState();
    expect(state.continueItem).toMatchObject({ conversationId, currentPage: null, manualSourceCount: 1, lastUserText: "Keep my original question" });
    expect(state.continueItem?.sourceVersions).toEqual({});
    expect((await assertSavedConversationOpens(conversationId)).sourceIds).toEqual([]);
    expect(await sql`SELECT id FROM opening_sources WHERE id=${sourceId}`).toHaveLength(1);
  });

  it.each(["missing", "version-changed", "version-unavailable", "out-of-range-snapshot", "foreign-source"] as const)("does not advertise %s as recoverable", async condition => {
    const sourceId = condition === "missing" ? randomUUID() : await material(condition === "foreign-source" ? other : owner);
    const { conversationId, turnId } = await savedConversation([sourceId]);
    if (condition === "version-changed") await sql`UPDATE opening_sources SET version=5 WHERE id=${sourceId}`;
    if (condition === "version-unavailable") await sql`UPDATE opening_source_versions SET availability='unavailable' WHERE source_id=${sourceId}`;
    if (condition === "out-of-range-snapshot") {
      // JSON permits this integer, but it cannot be a source's PostgreSQL integer version.
      const versions = { [sourceId]: 2_147_483_648 };
      await sql`UPDATE opening_turns SET source_versions=${sql.json(versions)} WHERE id=${turnId}`;
      expect((await sql`SELECT source_versions FROM opening_turns WHERE id=${turnId}`)[0]!.source_versions).toEqual(versions);
    }
    const state = await latestState();
    expect(state.continueItem).toMatchObject({ conversationId, currentPage: null, manualSourceCount: 0, lastUserText: "Keep my original question" });
    expect(state.continueItem?.sourceVersions).toEqual({});
  });

  it("does not invent a saved page when only the material can be restored", async () => {
    const sourceId = await material(owner, 9);
    await savedConversation([sourceId], 7);
    const state = await latestState();
    expect(state.continueItem?.sourceVersions).toEqual({ [sourceId]: 4 });
    expect(state.continueItem?.currentPage).toBeNull();
  });
});
