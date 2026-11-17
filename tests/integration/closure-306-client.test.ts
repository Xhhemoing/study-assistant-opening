import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createCourseMembershipRepository, createOpeningSourceRepository } from "@aistudy/database";
import { createAuthRuntime } from "../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../apps/web/src/server/runtime";
import { POST, PATCH } from "../../apps/web/src/app/api/courses/[id]/memberships/route";
import { GET } from "../../apps/web/src/app/api/courses/[id]/assets/route";
import { createCourseSourcePurposeClient } from "../../apps/web/src/features/opening/courses/course-source-purpose-client";
import { createOpeningCourseReadySourcesRepository } from "../../packages/database/src/repositories/opening-course-ready-sources";
import { readOpeningLearnerSnapshotCourses } from "../../packages/database/src/repositories/opening-learner-snapshot-read";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
let f: OpeningFixture, runtime: ReturnType<typeof createAuthRuntime>;
beforeAll(async () => {
  f = await createOpeningFixture();
  runtime = createAuthRuntime({ databaseUrl: process.env.OPENING_TEST_DATABASE_URL!, authSecret: process.env.AUTH_SECRET!, sessionCookieSecure: false, sessionTtlSeconds: 3600, authCookieName: "aistudy_session" }); setAuthRuntimeForTests(runtime);
});
afterAll(async () => { setAuthRuntimeForTests(null); await runtime?.close(); await f?.close(); });
const transport = vi.fn<typeof fetch>(async (input, init) => {
  const request = new Request(new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost"), init);
  request.headers.set("cookie", f.cookie);
  const context = { params: Promise.resolve({ id: new URL(request.url).pathname.split("/")[3]! }) };
  return request.method === "POST" ? POST(request, context) : request.method === "PATCH" ? PATCH(request, context) : GET(request, context);
});
async function seed() {
  const courses = createCourseMembershipRepository(f.sql), source = await createOpeningSourceRepository(f.sql).create(f.scope, { name: "synthetic-306.pdf", mime: "application/pdf", bytes: 12, sha256: "a".repeat(64) });
  const a = await courses.createCourse({ workspaceId: f.scope.workspaceId, title: "A", slug: randomUUID() }), b = await courses.createCourse({ workspaceId: f.scope.workspaceId, title: "B", slug: randomUUID() });
  await f.sql`UPDATE opening_sources SET upload_state='uploaded',parse_state='ready' WHERE id=${source.id}`;
  await f.sql`INSERT INTO opening_source_versions(source_id,version,workspace_id,bytes,sha256,availability) SELECT id,version,workspace_id,bytes,sha256,'available' FROM opening_sources WHERE id=${source.id}`;
  await f.sql`INSERT INTO opening_source_chunks(id,source_id,source_version,page,text) VALUES(${randomUUID()},${source.id},0,1,'Synthetic 306 material')`;
  return { a, b, source };
}
it("real clients/auth API persist course-local purpose: two stale snapshots produce one save and one typed conflict", async () => {
  const { a, b, source } = await seed(), first = createCourseSourcePurposeClient(transport), second = createCourseSourcePurposeClient(transport);
  await first.add(a.id, source.id, "optional", null); await first.add(b.id, source.id, "core", "teaching");
  const sourceBefore = await f.sql`SELECT * FROM opening_sources WHERE id=${source.id}`;
  const left = await first.read(a.id, source.id), right = await second.read(a.id, source.id);
  expect(left).toEqual(right);
  const outcomes = await Promise.allSettled([first.update(a.id, left, "practice"), second.update(a.id, right, "mock_exam")]);
  expect(outcomes.filter(row => row.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.find(row => row.status === "rejected")).toMatchObject({ status: "rejected", reason: { status: 409, code: "CONFLICT" } });
  const winner = outcomes.find(row => row.status === "fulfilled"); if (winner?.status !== "fulfilled") throw new Error("missing winner");
  const reloaded = await createCourseSourcePurposeClient(transport).read(a.id, source.id);
  expect(reloaded).toEqual(winner.value); expect(reloaded.updatedAt > left.updatedAt).toBe(true);
  expect((await first.read(b.id, source.id)).purpose).toBe("teaching"); expect(await f.sql`SELECT * FROM opening_sources WHERE id=${source.id}`).toEqual(sourceBefore);
  const [metadata] = await f.sql`SELECT role,visibility FROM course_asset_memberships WHERE id=${left.id}`;
  expect(metadata).toMatchObject({ role: "optional", visibility: "private" });
});
it("lost real PATCH acknowledgement recovers by GET, advances material revision and invalidates old purpose pin even after changed-back purpose", async () => {
  const { a, source } = await seed(), api = createCourseSourcePurposeClient(transport);
  const added = await api.add(a.id, source.id, "reference", null), pool = createOpeningCourseReadySourcesRepository(f.sql);
  const before = (await readOpeningLearnerSnapshotCourses(f.sql, f.scope)).find(row => row.courseId === a.id)!;
  const pin = await pool.readMaterialPurposePin(f.scope, { courseId: a.id, sourceIds: [source.id], materialUse: "teaching" });
  let writes = 0;
  const lost = createCourseSourcePurposeClient(async (input, init) => { const response = await transport(input, init); if (init?.method === "PATCH") { writes++; expect(response.status).toBe(200); throw new TypeError("synthetic loss after committed API response"); } return response; });
  await expect(lost.update(a.id, added, "teaching")).rejects.toThrow("synthetic loss"); expect(writes).toBe(1);
  const recovered = await createCourseSourcePurposeClient(transport).read(a.id, source.id); expect(recovered.purpose).toBe("teaching"); expect(recovered.updatedAt > added.updatedAt).toBe(true);
  const after = (await readOpeningLearnerSnapshotCourses(f.sql, f.scope)).find(row => row.courseId === a.id)!;
  expect(before.hasUsableMaterials).toBe(true); expect(after.hasUsableMaterials).toBe(true); expect(after.materialRevision).not.toBe(before.materialRevision);
  await expect(pool.assertMaterialPurposePin(f.scope, pin)).rejects.toMatchObject({ code: "CONFLICT" });
  const blocked = await api.update(a.id, recovered, "mock_exam"); expect(await pool.admitSourceIds(f.scope, a.id, [source.id], "teaching")).toEqual([]);
  await api.update(a.id, blocked, null); expect(await pool.admitSourceIds(f.scope, a.id, [source.id], "teaching")).toEqual([source.id]);
  await expect(pool.assertMaterialPurposePin(f.scope, pin)).rejects.toMatchObject({ code: "CONFLICT" }); expect(writes).toBe(1);
});
