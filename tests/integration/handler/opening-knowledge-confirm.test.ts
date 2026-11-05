import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createOpeningKnowledgeRepository } from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "../opening-fixture";
import { backupRows } from "../opening-backup-records-fixture";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";
import { POST } from "../../../apps/web/src/app/api/opening/courses/[id]/knowledge/confirm/route";

let f: OpeningFixture;
let runtime: ReturnType<typeof createAuthRuntime>;
beforeAll(async () => {
  f = await createOpeningFixture();
  runtime = createAuthRuntime({ databaseUrl: process.env.OPENING_TEST_DATABASE_URL!, authSecret: process.env.AUTH_SECRET!,
    sessionCookieSecure: false, sessionTtlSeconds: 3600, authCookieName: "aistudy_session" });
  setAuthRuntimeForTests(runtime);
  vi.stubEnv("OPENING_TEACHING_LOOP", "1");
});
afterAll(async () => {
  setAuthRuntimeForTests(null); vi.unstubAllEnvs();
  if (f) await f.sql`DELETE FROM workspaces WHERE id IN (${f.scope.workspaceId},${f.otherScope.workspaceId})`;
  await runtime?.close(); await f?.close();
});

async function seed(scope = f.scope) {
  const courseId = randomUUID(), nodeId = randomUUID();
  const rows = backupRows(f.sql, scope);
  const sourceId = await rows.source(), chunkId = await rows.chunk(sourceId);
  await f.sql`INSERT INTO opening_source_versions(source_id,version,workspace_id,bytes,sha256,availability)
    SELECT id,version,workspace_id,bytes,sha256,'available' FROM opening_sources WHERE id=${sourceId}`;
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${courseId},${scope.workspaceId},'Knowledge course',${courseId})`;
  await f.sql`INSERT INTO course_asset_memberships(id,workspace_id,course_id,asset_type,asset_id,role,sort_order,visibility)
    VALUES(${randomUUID()},${scope.workspaceId},${courseId},'source',${sourceId},'core',0,'course')`;
  const sourceVersions = { [sourceId]: 1 };
  await createOpeningKnowledgeRepository(f.sql).replace(scope, courseId, { expectedVersion: 0, sourceVersions,
    snapshot: { courseId, version: 1, edges: [], nodes: [{ id: nodeId, courseId, kind: "concept", label: "函数",
      evidenceChunkIds: [chunkId], status: "needs_check" }] } });
  return { courseId, nodeId, expectedVersion: 1, sourceVersions };
}
const send = (courseId: string, body: unknown, cookie = f.cookie) => POST(new Request(
  `http://localhost/api/opening/courses/${courseId}/knowledge/confirm`, { method: "POST",
    headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }),
{ params: Promise.resolve({ id: courseId }) });

it("requires authentication and rejects cross-workspace nodes without writing", async () => {
  const own = await seed(), foreign = await seed(f.otherScope);
  const { courseId, ...body } = own;
  expect((await send(courseId, body, "")).status).toBe(401);
  expect((await send(foreign.courseId, { ...body, nodeId: foreign.nodeId, sourceVersions: foreign.sourceVersions })).status).toBe(404);
  expect((await send(courseId, { ...body, nodeId: foreign.nodeId })).status).toBe(404);
  expect((await send(courseId, { ...body, workspaceId: f.otherScope.workspaceId })).status).toBe(400);
  expect(await f.sql`SELECT id FROM opening_knowledge_confirmations WHERE course_id IN (${courseId},${foreign.courseId})`).toHaveLength(0);
});

it("returns the updated graph; stale/duplicate input is a conflict", async () => {
  const { courseId, ...body } = await seed();
  const response = await send(courseId, body);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toMatchObject({ version: 2, snapshot: { version: 2, nodes: [{ id: body.nodeId, status: "supported" }] } });
  expect((await send(courseId, body)).status).toBe(409);
  expect(await f.sql`SELECT id FROM opening_knowledge_confirmations WHERE course_id=${courseId}`).toHaveLength(1);
});

it("validates pinned versions and rejects unexpected fields", async () => {
  const { courseId, ...body } = await seed();
  expect((await send(courseId, { nodeId: body.nodeId, expectedVersion: 1 })).status).toBe(400);
  expect((await send(courseId, { ...body, sourceVersions: {} })).status).toBe(409);
  expect((await send(courseId, { ...body, expectedVersion: 0 })).status).toBe(409);
  expect(await f.sql`SELECT id FROM opening_knowledge_confirmations WHERE course_id=${courseId}`).toHaveLength(0);
});
