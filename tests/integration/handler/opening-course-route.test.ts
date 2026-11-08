import { randomUUID } from "node:crypto";
import { courseRouteSnapshotSchema } from "@aistudy/contracts";
import { createOpeningLearningGoalRepository, createOpeningTeachingContentRepository } from "@aistudy/database";
import { createOpeningCourseRouteRepository } from "../../../packages/database/src/repositories/opening-course-route";
import { backupRows } from "../opening-backup-records-fixture";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createOpeningFixture, type OpeningFixture } from "../opening-fixture";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";
import { GET, PUT } from "../../../apps/web/src/app/api/opening/courses/[id]/learning-route/route";
import { GET as task } from "../../../apps/web/src/app/api/opening/courses/[id]/learning-route/task/route";
import { POST as retest } from "../../../apps/web/src/app/api/opening/courses/[id]/learning-route/retest/route";

let f: OpeningFixture, runtime: ReturnType<typeof createAuthRuntime>;
beforeAll(async () => {
  f = await createOpeningFixture();
  runtime = createAuthRuntime({ databaseUrl: process.env.OPENING_TEST_DATABASE_URL!, authSecret: process.env.AUTH_SECRET!,
    sessionCookieSecure: false, sessionTtlSeconds: 3600, authCookieName: "aistudy_session" });
  setAuthRuntimeForTests(runtime); vi.stubEnv("OPENING_TEACHING_LOOP", "1");
});
afterAll(async () => { setAuthRuntimeForTests(null); vi.unstubAllEnvs(); await runtime?.close(); await f?.close(); });
const context = (id: string) => ({ params: Promise.resolve({ id }) });
const request = (courseId: string, method: string, suffix = "", body?: unknown, cookie = f.cookie) =>
  new Request(`http://localhost/api/opening/courses/${courseId}/learning-route${suffix}`, { method,
    headers: { cookie, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

it("authenticates course manifests and keeps a missing requirement visible through the actual handler", async () => {
  const id = randomUUID();
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${id},${f.scope.workspaceId},'Handler course',${id})`;
  const requirement = { id: randomUUID(), stableSkillId: randomUUID(), knowledgeNodeId: null, requirementKey: "course:chapter-1",
    title: "第一章", position: 0, mandatory: true, goalIds: [], prerequisiteIds: [], sourceRefs: [], origin: "confirmed",
    verification: { kind: "unavailable", status: "missing", exerciseKeys: [], rubric: null, missingReasons: ["待补充材料"] } };
  const body = { expectedRevisions: [], requirements: [requirement], confirmScope: true };
  expect((await PUT(request(id, "PUT", "", body, ""), context(id))).status).toBe(401);
  const saved = await PUT(request(id, "PUT", "", body), context(id));
  expect(saved.status).toBe(200); expect(saved.headers.get("Cache-Control")).toBe("no-store");
  expect((await saved.json()).summary).toMatchObject({ total: 1, mandatory: 1, verified: 0, blocked: 1 });
  const read = await GET(request(id, "GET"), context(id));
  expect(read.status).toBe(200);
  const snapshot = courseRouteSnapshotSchema.parse(await read.json());
  expect(snapshot.requirements[0]!.requirement).toMatchObject({ id: requirement.id, revision: 1 });
  expect(snapshot.requirements[0]!.citationCoverage).toBeUndefined();
  expect((await PUT(request(id, "PUT", "", { ...body, workspaceId: f.otherScope.workspaceId }), context(id))).status).toBe(400);
});

it("serves the full rejected revision as counts through GET with a read-only database connection", async () => {
  const courseId = randomUUID(), requirementId = randomUUID(), rows = backupRows(f.sql, f.scope);
  const sourceId = await rows.source("uploaded", 0), chunkId = await rows.chunk(sourceId, 0);
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${courseId},${f.scope.workspaceId},'HTTP coverage',${courseId})`;
  await f.sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,visibility)
    VALUES(${f.scope.workspaceId},${courseId},'source',${sourceId},'core','course')`;
  const goal = await createOpeningLearningGoalRepository(f.sql).create(f.scope, { clientKey: randomUUID(), courseIds: [courseId],
    title: "API coverage", kind: "custom", targetDate: null, examDate: null, weeklyMinutes: 120, priority: 1,
    learningMode: "understand", successCriteria: "Full population" });
  const repo = createOpeningCourseRouteRepository(f.sql, { compilerEnabled: true });
  await repo.confirm(f.scope, courseId, { expectedRevisions: [], confirmScope: true, requirements: [{
    id: requirementId, stableSkillId: randomUUID(), knowledgeNodeId: null, requirementKey: "http-coverage", title: "API coverage",
    position: 0, mandatory: true, goalIds: [goal.id], prerequisiteIds: [], sourceRefs: [{ sourceId, sourceVersion: 0, chunkId }],
    origin: "confirmed", verification: { kind: "unavailable", status: "missing", exerciseKeys: [], rubric: null, missingReasons: [] },
  }] });
  const started = await repo.start(f.scope, courseId, { goalId: goal.id, expectedGoalRevision: 1,
    requirementId, expectedRequirementRevision: 1, clientKey: randomUUID(), minutes: 20 });
  if (started.kind !== "ready") throw new Error(started.reason);
  const content = createOpeningTeachingContentRepository(f.sql);
  const blocks = ["teach", "example", ...Array.from({ length: 5 }, () => ["prompt", "answer_key"]).flat()].map((role, position) => {
    const id = randomUUID(), status = position === 0 ? "bound" : "missing";
    return { id, type: role === "teach" ? "text" : role, content: { text: `private-coverage-body-${position}`,
      citationBinding: { blockId: id, role, status, factualSupport: "unverified",
        refs: status === "bound" ? [{ sourceId, sourceVersion: 0, chunkId, page: 1 }] : [] } } };
  });
  const blockOrder = blocks.map((block, position) => ({ blockId: block.id, blockType: block.type, position,
    role: (position === 0 ? "teach" : block.type) as "teach" | "example" | "prompt" | "answer_key" }));
  const unit = await content.createUnit(f.scope, { title: "API private body", blocks });
  await content.publishActivitySpec(f.scope, { activityId: started.activity.id, teachingUnitId: unit.id, expectedVersion: 0,
    revisionNumber: unit.currentRevisionNumber, blockOrder, sourceRefs: [{ sourceId, version: 0, chunkId, page: 1 }],
    verificationStatus: "rejected" });
  await content.writeUnitBlocks(f.scope, unit.id, [{ id: randomUUID(), type: "text", content: { text: "unpublished-head" } }]);
  const before = await f.sql`SELECT (SELECT count(*)::int FROM opening_jobs WHERE workspace_id=${f.scope.workspaceId}) AS jobs,
    (SELECT count(*)::int FROM opening_budget_reservations WHERE workspace_id=${f.scope.workspaceId}) AS budgets`;
  const url = new URL(process.env.OPENING_TEST_DATABASE_URL!);
  url.searchParams.set("options", "-c default_transaction_read_only=on");
  const readonlyRuntime = createAuthRuntime({ databaseUrl: url.toString(), authSecret: process.env.AUTH_SECRET!,
    sessionCookieSecure: false, sessionTtlSeconds: 3600, authCookieName: "aistudy_session" });
  setAuthRuntimeForTests(readonlyRuntime);
  try {
    expect((await readonlyRuntime.sql`SHOW transaction_read_only`)[0]!.transaction_read_only).toBe("on");
    const read = async () => {
      const response = await GET(request(courseId, "GET"), context(courseId));
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      const raw: unknown = await response.json();
      expect(JSON.stringify(raw)).not.toContain("private-coverage-body");
      expect(JSON.stringify(raw)).not.toContain("unpublished-head");
      return courseRouteSnapshotSchema.parse(raw).requirements[0]!;
    };
    const current = await read();
    expect(current.citationCoverage).toMatchObject({ total: 12, bound: 1, missing: 11, unknown: 0,
      byRole: { teach: { total: 1 }, example: { total: 1 }, prompt: { total: 5 }, answer_key: { total: 5 } } });
    expect(current.compilation).toMatchObject({ verificationStatus: "rejected", saved: true });
    const serialized = JSON.stringify(current.citationCoverage);
    for (const secret of [sourceId, chunkId, "refs", "blockId", "private-"]) expect(serialized).not.toContain(secret);
    const legacy = await content.writeUnitBlocks(f.scope, unit.id, blocks.map(block => ({ ...block,
      content: { text: "private-coverage-body-legacy" } })));
    await content.publishActivitySpec(f.scope, { activityId: started.activity.id, teachingUnitId: unit.id, expectedVersion: 1,
      revisionNumber: legacy.revisionNumber, blockOrder, sourceRefs: [{ sourceId, version: 0, chunkId, page: 1 }],
      verificationStatus: "rejected" });
    const historical = await read();
    expect(historical.citationCoverage).toMatchObject({ total: 12, bound: 0, unknown: 12 });
    expect(historical.missingReasons).toContain("引用覆盖未知：部分历史绑定缺失或无效");
    await rows.exclude(sourceId);
    const revoked = await read();
    expect(revoked.citationCoverage).toBeUndefined();
    expect(revoked.missingReasons).toContain("引用覆盖未知：当前来源授权、版本或位置不可用");
    const foreignCourse = randomUUID();
    await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${foreignCourse},${f.otherScope.workspaceId},'Foreign coverage',${foreignCourse})`;
    expect((await GET(request(foreignCourse, "GET"), context(foreignCourse))).status).toBe(404);
    const after = await f.sql`SELECT (SELECT count(*)::int FROM opening_jobs WHERE workspace_id=${f.scope.workspaceId}) AS jobs,
      (SELECT count(*)::int FROM opening_budget_reservations WHERE workspace_id=${f.scope.workspaceId}) AS budgets`;
    expect(after).toEqual(before);
  } finally { setAuthRuntimeForTests(runtime); await readonlyRuntime.close(); }
});

it("rejects foreign course/task identity and client-invented delayed evidence without writes", async () => {
  const id = randomUUID(), taskId = randomUUID();
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${id},${f.otherScope.workspaceId},'Foreign course',${id})`;
  expect((await GET(request(id, "GET"), context(id))).status).toBe(404);
  expect((await task(request(id, "GET", `/task?taskId=${taskId}`), context(id))).status).toBe(404);
  const response = await retest(request(id, "POST", "/retest", { goalId: randomUUID(), expectedGoalRevision: 1,
    activityId: randomUUID(), expectedPathVersion: 1, observationId: randomUUID(), clientKey: randomUUID(), minutes: 20 }), context(id));
  expect(response.status).toBe(404);
  const [count] = await f.sql`SELECT count(*)::int AS count FROM opening_retest_activities WHERE workspace_id=${f.scope.workspaceId}`;
  expect(count!.count).toBe(0);
});
