import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { type CourseRouteRequirementInput } from "@aistudy/contracts";
import { createLibraryRepository, createOpeningLearningGoalRepository, createOpeningTeachingActivitiesRepository, createOpeningTeachingContentRepository } from "@aistudy/database";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";
import { GET, PUT } from "../../../apps/web/src/app/api/opening/courses/[id]/learning-route/route";
import { POST as start } from "../../../apps/web/src/app/api/opening/courses/[id]/learning-route/start/route";
import { POST as adopt } from "../../../apps/web/src/app/api/opening/teaching-activities/[id]/reference-revision/route";
import { GET as init } from "../../../apps/web/src/app/api/opening/teaching-activities/[id]/client-init/route";
import { createOpeningApi } from "../../../apps/web/src/features/opening/client/api";
import { createCourseRouteClient } from "../../../apps/web/src/features/opening/courses/course-route-client";
import { createOpeningFixture, type OpeningFixture } from "../opening-fixture";
import { backupRows } from "../opening-backup-records-fixture";

let f: OpeningFixture, runtime: ReturnType<typeof createAuthRuntime>;
const context = (id: string) => ({ params: Promise.resolve({ id }) });
beforeAll(async () => {
  f = await createOpeningFixture();
  runtime = createAuthRuntime({ databaseUrl: process.env.OPENING_TEST_DATABASE_URL!, authSecret: process.env.AUTH_SECRET!, sessionCookieSecure: false, sessionTtlSeconds: 3600, authCookieName: "aistudy_session" });
  setAuthRuntimeForTests(runtime);
  vi.stubEnv("OPENING_TEACHING_LOOP", "1");
  vi.stubEnv("OPENING_TEACHING_COMPILER_ENABLED", "1");
});
afterAll(async () => { setAuthRuntimeForTests(null); vi.unstubAllEnvs(); await runtime?.close(); await f?.close(); });

// Real browser-client transport, injecting only the fixture's authenticated cookie.
const transport: typeof fetch = async (url, options) => {
  const request = new Request(new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url, "http://localhost"), options);
  request.headers.set("cookie", f.cookie);
  const parts = new URL(request.url).pathname.split("/");
  const id = parts[4]!;
  if (parts[5] === "reference-revision") return adopt(request, context(id));
  if (parts[5] === "client-init") return init(request, context(id));
  if (parts[5] === "learning-route") {
    if (parts[6] === "start") return start(request, context(id));
    return request.method === "PUT" ? PUT(request, context(id)) : GET(request, context(id));
  }
  throw new Error(`Unexpected transport path ${request.url}`);
};
async function workspaceContents() {
  const tables = await f.sql`SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='workspace_id' ORDER BY table_name`;
  const result: Record<string, unknown> = {};
  for (const table of tables) result[String(table.table_name)] = await f.sql`SELECT to_jsonb(t) AS row FROM ${f.sql(String(table.table_name))} t WHERE workspace_id=${f.scope.workspaceId} ORDER BY to_jsonb(t)::text`;
  return JSON.stringify(result);
}
async function historyAndCosts() {
  const tables = ["library_revisions", "opening_learning_attempts", "opening_learning_observations", "opening_jobs", "opening_outbox", "opening_budget_reservations"];
  const result: Record<string, unknown> = {};
  for (const table of tables) result[table] = await f.sql`SELECT to_jsonb(t) AS row FROM ${f.sql(table)} t WHERE workspace_id=${f.scope.workspaceId} ORDER BY to_jsonb(t)::text`;
  return result;
}

it("adopts through client → authenticated API → strict course read, preserving denominator, unknown and history", async () => {
  const courseId = randomUUID(), rows = backupRows(f.sql, f.scope), sourceId = await rows.source("uploaded", 1), chunkId = await rows.chunk(sourceId, 1);
  await f.sql`UPDATE opening_source_chunks SET image_object_key=NULL,text='有理数运算' WHERE id=${chunkId}`;
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${courseId},${f.scope.workspaceId},'Reference revision client',${courseId})`;
  await f.sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,visibility) VALUES(${f.scope.workspaceId},${courseId},'source',${sourceId},'core','course')`;
  const goal = await createOpeningLearningGoalRepository(f.sql).create(f.scope, { clientKey: randomUUID(), courseIds: [courseId], title: "运算", kind: "custom", targetDate: null, examDate: null, weeklyMinutes: 120, priority: 1, learningMode: "understand", successCriteria: "独立计算" });
  const requirements: CourseRouteRequirementInput[] = Array.from({ length: 3 }, (_, position) => ({ id: randomUUID(), stableSkillId: randomUUID(), knowledgeNodeId: null, requirementKey: `arithmetic:${position}`, title: `运算${position}`, position, mandatory: true, goalIds: [goal.id], prerequisiteIds: [], sourceRefs: [{ sourceId, sourceVersion: 1, chunkId }], verification: { kind: "rubric", status: "ready", exerciseKeys: ["arithmetic"], rubric: "精确运算", missingReasons: [] }, origin: "confirmed" }));
  const course = createCourseRouteClient(transport), api = createOpeningApi(transport);
  await course.confirm(courseId, { expectedRevisions: [], requirements, confirmScope: true });
  // Ready is a server-side fixture fact, never trusted from a confirmation request.
  for (const requirement of requirements) await f.sql`UPDATE course_requirements SET verification=${f.sql.json(requirement.verification)} WHERE id=${requirement.id} AND workspace_id=${f.scope.workspaceId} AND owner_user_id=${f.scope.ownerUserId}`;
  const started = await course.start(courseId, { goalId: goal.id, expectedGoalRevision: 1, requirementId: requirements[0]!.id, expectedRequirementRevision: 1, clientKey: randomUUID(), minutes: 20 });
  if (started.kind !== "ready") throw new Error(JSON.stringify(started));
  const activityId = started.activity.id, content = createOpeningTeachingContentRepository(f.sql);
  const blocks = [{ id: randomUUID(), type: "prompt", content: { text: "计算 2+3" } }, { id: randomUUID(), type: "answer_key", content: { text: "4" } }];
  const unit = await content.createUnit(f.scope, { title: "运算讲义", blocks });
  await content.publishActivitySpec(f.scope, { activityId, teachingUnitId: unit.id, expectedVersion: 0, revisionNumber: 1, verificationStatus: "needs_check", sourceRefs: [{ sourceId, version: 1, chunkId }], blockOrder: blocks.map((b, position) => ({ blockId: b.id, blockType: b.type, position, role: position ? "answer_key" : "prompt" })) });
  // Synthetic compilation has finished; keep the real guard against adopting queued output.
  expect(await createOpeningTeachingActivitiesRepository(f.sql).setGenerateStatus(f.scope, activityId, "needs_check", { from: ["queued", "unknown"] })).toBe(true);
  const revisionBytes = async () => f.sql`SELECT to_jsonb(t)::text AS bytes FROM library_revisions t WHERE workspace_id=${f.scope.workspaceId} AND document_id=${unit.documentId} AND revision_number=1`;
  const original = await revisionBytes();
  const coverage = { savedQuestions: 1, withReferenceAnswers: 1, issuedQuestions: 0, unexposedEligibility: "unknown" };
  async function readWithoutWrites() {
    const before = await workspaceContents();
    const snapshot = await course.read(courseId);
    expect(await workspaceContents()).toBe(before);
    expect(snapshot.summary).toEqual({ total: 3, mandatory: 3, verified: 0, blocked: 0 });
    expect(snapshot.requirements.map(row => row.requirement.id)).toEqual(requirements.map(row => row.id));
    expect(snapshot.requirements[0]!.questionCoverage).toEqual(coverage);
    for (const row of snapshot.requirements.slice(1)) {
      expect(row.compilation).toMatchObject({ saved: false, activityId: null, contentVersion: 0, revisionNumber: null });
      expect(row.questionCoverage).toEqual({ savedQuestions: 0, withReferenceAnswers: 0, issuedQuestions: 0, unexposedEligibility: "unknown" });
    }
    return snapshot;
  }
  const old = await readWithoutWrites();
  expect(old.requirements[0]!.referenceChecks).toEqual({ matched: 0, mismatched: 1, unsupported: 0 });
  expect(old.requirements[0]!.compilation).toMatchObject({ contentVersion: 1, revisionNumber: 1, saved: true });
  const edited = structuredClone(blocks); edited[1]!.content.text = "5";
  await createLibraryRepository(f.sql).updateDocument({ workspaceId: f.scope.workspaceId, documentId: unit.documentId, expectedRevisionNumber: 1, blocks: edited });
  expect(await readWithoutWrites()).toEqual(old);
  const beforeAdopt = await historyAndCosts();
  const adopted = await api.adoptTeachingReferenceRevision(activityId, { expectedContentVersion: 1, expectedRevisionNumber: 1, revisionNumber: 2 });
  expect(adopted).toMatchObject({ activityId, version: 2, revisionNumber: 2, verificationStatus: "needs_check" });
  expect(await historyAndCosts()).toEqual(beforeAdopt);
  expect(await revisionBytes()).toEqual(original);
  const current = await readWithoutWrites();
  expect(current.requirements[0]!.compilation).toMatchObject({ contentVersion: 2, revisionNumber: 2, saved: true, verificationStatus: "needs_check" });
  expect(current.requirements[0]!.referenceChecks).toEqual({ matched: 1, mismatched: 0, unsupported: 0 });
  const beforeInit = await workspaceContents();
  const student = await api.getTeachingClientInit(activityId);
  expect(student).toMatchObject({ version: 2, contentVersion: 2, revisionNumber: 2, blocks: [{ content: { text: "计算 2+3" } }, { content: null, answerRef: { revealState: "hidden" } }] });
  expect(await workspaceContents()).toBe(beforeInit);

  // A genuinely reconfirmed requirement makes the old activity non-current.
  await course.confirm(courseId, { expectedRevisions: requirements.map(r => ({ id: r.id, revision: 1 })), requirements: requirements.map((r, i) => i ? r : { ...r, title: "修订后的运算要求" }), confirmScope: true });
  edited[1]!.content.text = "5.0";
  await createLibraryRepository(f.sql).updateDocument({ workspaceId: f.scope.workspaceId, documentId: unit.documentId, expectedRevisionNumber: 2, blocks: edited });
  const beforeConflict = await workspaceContents();
  await expect(api.adoptTeachingReferenceRevision(activityId, { expectedContentVersion: 2, expectedRevisionNumber: 2, revisionNumber: 3 })).rejects.toMatchObject({ status: 409 });
  expect(await workspaceContents()).toBe(beforeConflict);
  console.info("client→auth→strict course", JSON.stringify({ version: adopted.version, pin: adopted.revisionNumber, referenceChecks: current.requirements[0]!.referenceChecks, questionCoverage: current.requirements[0]!.questionCoverage, summary: current.summary }));
});
