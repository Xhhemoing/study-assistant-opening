import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCourseMembershipRepository, createOpeningSourceRepository, createOpeningKnowledgeRepository } from "@aistudy/database";
import { createAuthRuntime } from "../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../apps/web/src/server/runtime";
import { POST, PATCH } from "../../apps/web/src/app/api/courses/[id]/memberships/route";
import { GET as GET_ASSETS } from "../../apps/web/src/app/api/courses/[id]/assets/route";
import { courseSourcePurposeAllows } from "../../packages/contracts/src/opening/sources";
import { listReadySourceIdsForCourse, createOpeningCourseReadySourcesRepository } from "../../packages/database/src/repositories/opening-course-ready-sources";
import { readOpeningLearnerSnapshotCourses } from "../../packages/database/src/repositories/opening-learner-snapshot-read";
import { assertOpeningTeachingSourcePurposes } from "../../packages/database/src/repositories/opening-teaching-activities";
import { readCourseRouteMaterials, readCourseRouteSourceChunks } from "../../packages/database/src/repositories/opening-course-route-read";
import { resolveOpeningStudyContext } from "../../packages/database/src/repositories/opening-study-context";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

// Uses the real contiguous migration chain via createOpeningFixture. Do not
// inject a placeholder 0109, apply 0110 in isolation, or weaken migration guards.
let f: OpeningFixture;
beforeAll(async () => { f = await createOpeningFixture(); });
afterAll(async () => { await f?.close(); });

async function setup() {
  const courses = createCourseMembershipRepository(f.sql);
  const source = await createOpeningSourceRepository(f.sql).create(f.scope, {
    name: "purpose.pdf", mime: "application/pdf", bytes: 12, sha256: "a".repeat(64),
  });
  const course = await courses.createCourse({ workspaceId: f.scope.workspaceId, title: "Purpose course", slug: randomUUID() });
  const input = { workspaceId: f.scope.workspaceId, courseId: course.id, assetType: "source" as const, assetId: source.id };
  const membership = await courses.addAssetMembership({ ...input, role: "optional", sortOrder: 7, visibility: "private" });
  return { courses, source, course, input, membership };
}

async function ready(sourceId: string) {
  await f.sql`UPDATE opening_sources SET upload_state='uploaded',parse_state='ready' WHERE id=${sourceId}`;
  await f.sql`INSERT INTO opening_source_versions(source_id,version,workspace_id,bytes,sha256,availability)
    SELECT id,version,workspace_id,bytes,sha256,'available' FROM opening_sources WHERE id=${sourceId}`;
  await f.sql`INSERT INTO opening_source_chunks(id,source_id,source_version,page,text)
    VALUES(${randomUUID()},${sourceId},0,1,'Synthetic purpose material')`;
}

describe("course source purpose storage and concurrency", () => {
  it("exposes real POST/PATCH/GET with CAS, rejects metadata mutation and retains authorization", async () => {
    const runtime = createAuthRuntime({ databaseUrl: process.env.OPENING_TEST_DATABASE_URL!, authSecret: process.env.AUTH_SECRET!,
      sessionCookieSecure: false, sessionTtlSeconds: 3600, authCookieName: "aistudy_session" });
    setAuthRuntimeForTests(runtime);
    try {
      const { courses, source, course, input } = await setup();
      await courses.removeAssetMembership(input);
      const context = { params: Promise.resolve({ id: course.id }) };
      const request = (method: string, body?: unknown, cookie = f.cookie) => new Request(`http://localhost/api/courses/${course.id}/memberships`, {
        method, headers: { cookie, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const post = await POST(request("POST", { assetType: "source", assetId: source.id, purpose: "reference", role: "optional", visibility: "private" }), context);
      expect(post.status).toBe(201);
      const created = (await post.json()).membership;
      expect(created).toMatchObject({ purpose: "reference", courseId: course.id, assetId: source.id });
      expect(created.updatedAt).toMatch(/\.\d{3}Z$/);
      const patchBody = { assetType: "source", assetId: source.id, purpose: "practice", expectedUpdatedAt: created.updatedAt };
      expect((await PATCH(request("PATCH", { ...patchBody, role: "archive" }), context)).status).toBe(400);
      expect((await PATCH(request("PATCH", patchBody, ""), context)).status).toBe(401);
      const patch = await PATCH(request("PATCH", patchBody), context);
      expect(patch.status).toBe(200);
      expect((await patch.json()).membership).toMatchObject({ purpose: "practice", role: "optional", visibility: "private" });
      const stale = await PATCH(request("PATCH", patchBody), context);
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({ error: { code: "CONFLICT" } });
      const assets = await GET_ASSETS(request("GET"), context);
      expect(assets.status).toBe(200);
      const [asset] = (await assets.json()).assets;
      expect(asset).toMatchObject({ courseId: course.id, purpose: "practice", assetId: source.id });
      expect(asset.updatedAt).toMatch(/\.\d{3}Z$/);
      expect(asset.source).not.toHaveProperty("purpose");
      expect(asset.source).not.toHaveProperty("courseId");
      const foreign = await createCourseMembershipRepository(f.sql).createCourse({ workspaceId: f.otherScope.workspaceId, title: "Private", slug: randomUUID() });
      const forbidden = await PATCH(request("PATCH", patchBody), { params: Promise.resolve({ id: foreign.id }) });
      expect(forbidden.status).toBe(404);
      expect((await courses.getMembership(input)).purpose).toBe("practice");
    } finally { setAuthRuntimeForTests(null); await runtime.close(); }
  });

  it.each([null, "teaching", "practice", "reference", "mock_exam"] as const)("enforces %s across teaching pools, explicit selections, context and planning", async purpose => {
    const { courses, source, course, input, membership } = await setup();
    await ready(source.id);
    if (purpose !== null) await courses.updateAssetMembership({ ...input, purpose, expectedUpdatedAt: membership.updatedAt.toISOString() });
    const teaching = purpose === null || purpose === "teaching";
    expect(await listReadySourceIdsForCourse(f.sql, f.scope, course.id)).toEqual(teaching ? [source.id] : []);
    const pool = createOpeningCourseReadySourcesRepository(f.sql);
    for (const use of ["teaching", "practice", "citation"] as const) {
      expect(await pool.admitSourceIds(f.scope, course.id, [source.id], use))
        .toEqual(courseSourcePurposeAllows(purpose, use) ? [source.id] : []);
    }
    const checkTeaching = () => f.sql.begin(tx => assertOpeningTeachingSourcePurposes(tx, f.scope, course.id, [source.id]));
    if (teaching) await expect(checkTeaching()).resolves.toBeUndefined();
    else await expect(checkTeaching()).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await readCourseRouteMaterials(f.sql, f.scope, course.id)).map(row => row.sourceId)).toEqual(teaching ? [source.id] : []);
    expect((await readCourseRouteSourceChunks(f.sql, f.scope, course.id)).map(row => row.sourceId)).toEqual(teaching ? [source.id] : []);
    const snapshot = (await readOpeningLearnerSnapshotCourses(f.sql, f.scope)).find(row => row.courseId === course.id);
    expect(snapshot?.hasUsableMaterials).toBe(teaching);
    const context = { purpose: "material_read" as const, courseId: course.id, sourceId: source.id };
    if (purpose === "mock_exam") await expect(f.sql.begin(tx => resolveOpeningStudyContext(tx, f.scope, context))).rejects.toMatchObject({ code: "CONFLICT" });
    else await expect(f.sql.begin(tx => resolveOpeningStudyContext(tx, f.scope, context))).resolves.toMatchObject({ sourceId: source.id });
    await expect(f.sql.begin(tx => resolveOpeningStudyContext(tx, f.scope, context, { sourceAccess: "human_read" })))
      .resolves.toMatchObject({ sourceId: source.id });
  });

  it("filters knowledge evidence and stale reads without changing the confirmed graph lifecycle", async () => {
    const { courses, source, course, input, membership } = await setup();
    await ready(source.id);
    const knowledge = createOpeningKnowledgeRepository(f.sql);
    const chunks = await knowledge.listAuthorizedChunks(f.scope, course.id);
    expect(chunks).toHaveLength(1);
    const nodeId = randomUUID();
    const sourceVersions = { [source.id]: 0 };
    const saved = await knowledge.replace(f.scope, course.id, { expectedVersion: 0, sourceVersions,
      snapshot: { courseId: course.id, version: 1, nodes: [{ id: nodeId, courseId: course.id,
        label: "Synthetic", kind: "concept", status: "needs_check", evidenceChunkIds: [chunks[0]!.id] }], edges: [] } });
    await knowledge.confirmNode(f.scope, course.id, nodeId, { expectedVersion: saved.version, sourceVersions });
    const before = await f.sql`SELECT * FROM opening_course_knowledge WHERE course_id=${course.id}`;
    const confirmations = await f.sql`SELECT * FROM opening_knowledge_confirmations WHERE course_id=${course.id}`;
    const changed = await courses.updateAssetMembership({ ...input, purpose: "mock_exam", expectedUpdatedAt: membership.updatedAt.toISOString() });
    expect(await knowledge.listAuthorizedChunks(f.scope, course.id)).toEqual([]);
    expect(await knowledge.get(f.scope, course.id)).toBeNull();
    expect(await knowledge.getForRebuild(f.scope, course.id)).toBeNull();
    await expect(knowledge.assertExtractionBatch(f.scope, course.id, chunks)).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await f.sql`SELECT * FROM opening_course_knowledge WHERE course_id=${course.id}`).toEqual(before);
    expect(await f.sql`SELECT * FROM opening_knowledge_confirmations WHERE course_id=${course.id}`).toEqual(confirmations);
    await courses.updateAssetMembership({ ...input, purpose: null, expectedUpdatedAt: changed.updatedAt.toISOString() });
    expect((await knowledge.get(f.scope, course.id))?.snapshot.nodes[0]?.status).toBe("supported");
    expect(await f.sql`SELECT * FROM opening_knowledge_confirmations WHERE course_id=${course.id}`).toEqual(confirmations);
  });

  it("invalidates material revision on purpose changes even when both states admit teaching", async () => {
    const { courses, source, course, input, membership } = await setup();
    await ready(source.id);
    const before = (await readOpeningLearnerSnapshotCourses(f.sql, f.scope)).find(row => row.courseId === course.id)!;
    await courses.updateAssetMembership({ ...input, purpose: "teaching", expectedUpdatedAt: membership.updatedAt.toISOString() });
    const after = (await readOpeningLearnerSnapshotCourses(f.sql, f.scope)).find(row => row.courseId === course.id)!;
    expect(before.hasUsableMaterials).toBe(true);
    expect(after.hasUsableMaterials).toBe(true);
    expect(after.materialRevision).not.toBe(before.materialRevision);
  });

  it("retains unknown null and independently classifies one source in different courses", async () => {
    const { courses, source, input, membership } = await setup();
    expect(membership.purpose).toBeNull();
    const other = await courses.createCourse({ workspaceId: f.scope.workspaceId, title: "Other purpose course", slug: randomUUID() });
    await courses.addAssetMembership({ ...input, courseId: other.id, purpose: "teaching", role: "core", visibility: "course" });
    const before = await f.sql`SELECT * FROM opening_sources WHERE id=${source.id}`;
    const updated = await courses.updateAssetMembership({ ...input, purpose: "mock_exam", expectedUpdatedAt: membership.updatedAt.toISOString() });
    expect(updated).toMatchObject({ purpose: "mock_exam", role: "optional", visibility: "private", sortOrder: 7 });
    expect((await courses.getMembership({ ...input, courseId: other.id })).purpose).toBe("teaching");
    expect(await f.sql`SELECT * FROM opening_sources WHERE id=${source.id}`).toEqual(before);
    const cleared = await courses.updateAssetMembership({ ...input, purpose: null, expectedUpdatedAt: updated.updatedAt.toISOString() });
    expect(cleared.purpose).toBeNull();
  });

  it("accepts the returned millisecond token for a legacy microsecond timestamp, then rejects its reuse", async () => {
    const { courses, input, membership } = await setup();
    await f.sql`UPDATE course_asset_memberships SET updated_at='2026-01-01T00:00:00.123456Z' WHERE id=${membership.id}`;
    const current = await courses.getMembership(input);
    const changed = await courses.updateAssetMembership({ ...input, purpose: "practice", expectedUpdatedAt: current.updatedAt.toISOString() });
    expect(changed.updatedAt.getTime()).toBeGreaterThan(current.updatedAt.getTime());
    await expect(courses.updateAssetMembership({ ...input, purpose: "reference", expectedUpdatedAt: current.updatedAt.toISOString() }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect((await courses.getMembership(input)).purpose).toBe("practice");
  });

  it("allows exactly one concurrent purpose writer and preserves unrelated metadata changes", async () => {
    const { courses, input, membership } = await setup();
    const expectedUpdatedAt = membership.updatedAt.toISOString();
    const outcomes = await Promise.allSettled([
      courses.updateAssetMembership({ ...input, purpose: "teaching", expectedUpdatedAt }),
      courses.updateAssetMembership({ ...input, purpose: "mock_exam", expectedUpdatedAt }),
    ]);
    expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
    const failed = outcomes.find(outcome => outcome.status === "rejected");
    expect(failed).toMatchObject({ status: "rejected", reason: { code: "CONFLICT" } });
    const current = await courses.getMembership(input);
    const metadata = await courses.updateAssetMembership({ ...input, role: "archive", sortOrder: 19 });
    expect(metadata).toMatchObject({ role: "archive", sortOrder: 19, visibility: "private", purpose: current.purpose });
    expect(metadata.updatedAt.getTime()).toBeGreaterThan(current.updatedAt.getTime());
    await expect(courses.updateAssetMembership({ ...input, purpose: null, expectedUpdatedAt: current.updatedAt.toISOString() }))
      .rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("enforces enum and source-only purpose in PostgreSQL, not just request parsing", async () => {
    const { membership } = await setup();
    await expect(f.sql`UPDATE course_asset_memberships SET purpose='unknown' WHERE id=${membership.id}`)
      .rejects.toMatchObject({ code: "23514" });
    await expect(f.sql`UPDATE course_asset_memberships SET asset_type='document',purpose='teaching' WHERE id=${membership.id}`)
      .rejects.toMatchObject({ code: "23514" });
    const [row] = await f.sql`SELECT asset_type,purpose FROM course_asset_memberships WHERE id=${membership.id}`;
    expect(row).toMatchObject({ asset_type: "source", purpose: null });
  });
});
