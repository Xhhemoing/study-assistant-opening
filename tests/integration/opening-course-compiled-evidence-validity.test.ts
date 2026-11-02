// @vitest-environment jsdom
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { activitySpecPublishInputSchema, courseRouteSnapshotSchema, type CourseRouteRequirementInput, type TeachingSourceRef } from "@aistudy/contracts";
import { createOpeningLearningGoalRepository, createOpeningTeachingContentRepository, createSqlClient } from "@aistudy/database";
import { assertOpeningTestDatabase } from "@aistudy/config";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { createOpeningCourseRouteRepository } from "../../packages/database/src/repositories/opening-course-route";
import { CourseRoutePanel } from "../../apps/web/src/features/opening/courses/course-route-panel";
import { createCourseRouteClient } from "../../apps/web/src/features/opening/courses/course-route-client";
import { backupRows } from "./opening-backup-records-fixture";

let sql: ReturnType<typeof createSqlClient>;
let scope: { workspaceId: string; ownerUserId: string };
beforeEach(async () => {
  scope = { workspaceId: randomUUID(), ownerUserId: randomUUID() };
  sql = createSqlClient(assertOpeningTestDatabase(process.env.OPENING_TEST_DATABASE_URL ?? "", process.env.OPENING_TEST_DB).toString());
  await sql`INSERT INTO users(id,email,display_name,password_hash) VALUES(${scope.ownerUserId},${scope.ownerUserId + "@example.com"},'Evidence validity','test')`;
  await sql`INSERT INTO workspaces(id,owner_user_id) VALUES(${scope.workspaceId},${scope.ownerUserId})`;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(async () => { vi.unstubAllGlobals(); await sql?.end({ timeout: 5 }); });

async function scopeContents() {
  const tables = await sql`SELECT table_name FROM information_schema.columns
    WHERE table_schema='public' AND column_name='workspace_id' ORDER BY table_name`;
  const result: Record<string, unknown> = {};
  for (const table of tables) result[String(table.table_name)] = await sql`SELECT to_jsonb(t) AS row FROM ${sql(String(table.table_name))} t
    WHERE workspace_id=${scope.workspaceId} ORDER BY to_jsonb(t)::text`;
  result.chunks = await sql`SELECT to_jsonb(c) AS row FROM opening_source_chunks c JOIN opening_sources s ON s.id=c.source_id
    WHERE s.workspace_id=${scope.workspaceId} ORDER BY to_jsonb(c)::text`;
  result.workspace = await sql`SELECT to_jsonb(w) AS row FROM workspaces w WHERE id=${scope.workspaceId}`;
  result.owner = await sql`SELECT to_jsonb(u) AS row FROM users u WHERE id=${scope.ownerUserId}`;
  return JSON.stringify(result);
}

it("requires each current spec chunk/page to match exactly through PG → strict client → panel, preserving all scoped rows", async () => {
  const rows = backupRows(sql, scope), courseId = randomUUID();
  const sourceId = await rows.source(), chunkId = await rows.chunk(sourceId);
  const otherChunkId = randomUUID(), otherSourceId = await rows.source();
  const foreignChunkId = await rows.chunk(otherSourceId), oldVersionChunkId = await rows.chunk(sourceId, 2);
  await sql`INSERT INTO opening_source_chunks(id,source_id,source_version,page,text)
    VALUES(${otherChunkId},${sourceId},1,2,'another page')`;
  await sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${courseId},${scope.workspaceId},'Evidence validity',${courseId})`;
  for (const id of [sourceId, otherSourceId]) await sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,visibility)
    VALUES(${scope.workspaceId},${courseId},'source',${id},'core','course')`;
  const goal = await createOpeningLearningGoalRepository(sql).create(scope, { clientKey: randomUUID(), courseIds: [courseId], title: "运算", kind: "custom", targetDate: null, examDate: null, weeklyMinutes: 120, priority: 1, learningMode: "understand", successCriteria: "独立计算" });
  // The requirement deliberately admits the whole source, not the spec's narrower evidence.
  const requirements: CourseRouteRequirementInput[] = Array.from({ length: 3 }, (_, position) => ({ id: randomUUID(), stableSkillId: randomUUID(), knowledgeNodeId: null,
    requirementKey: `arithmetic:${position}`, title: `运算要求${position}`, position, mandatory: true, goalIds: [goal.id], prerequisiteIds: [],
    sourceRefs: [{ sourceId, sourceVersion: 1 }], verification: { kind: "rubric", status: "ready", exerciseKeys: ["arithmetic"], rubric: "精确运算", missingReasons: [] }, origin: "confirmed" }));
  const repo = createOpeningCourseRouteRepository(sql, { compilerEnabled: true });
  await repo.confirm(scope, courseId, { expectedRevisions: [], requirements, confirmScope: true });
  const start = await repo.start(scope, courseId, { goalId: goal.id, expectedGoalRevision: 1, requirementId: requirements[0]!.id, expectedRequirementRevision: 1, clientKey: randomUUID(), minutes: 20 });
  if (start.kind !== "ready") throw new Error(JSON.stringify(start));
  const content = createOpeningTeachingContentRepository(sql);
  const blocks = [{ id: randomUUID(), type: "prompt", content: { text: "计算：17 + 19" } },
    { id: randomUUID(), type: "answer_key", content: { text: "36" } }];
  const unit = await content.createUnit(scope, { title: "引用讲义", blocks: [{ id: randomUUID(), type: "text", content: { text: "初始讲义" } }] });
  const revision = await content.writeUnitBlocks(scope, unit.id, blocks);
  const spec = await content.publishActivitySpec(scope, activitySpecPublishInputSchema.parse({ activityId: start.activity.id, teachingUnitId: unit.id, expectedVersion: 0,
    revisionNumber: revision.revisionNumber, blockOrder: blocks.map((b, position) => ({ blockId: b.id, blockType: b.type, role: b.type === "prompt" ? "prompt" : "answer_key", position })),
    sourceRefs: [{ sourceId, version: 1, chunkId, page: 1 }], verificationStatus: "needs_check" }));
  const sourceRef = { sourceId, version: 1 };
  async function check(label: string, saved: boolean, sourcesAvailable = true) {
    const before = await scopeContents();
    const response = await repo.read(scope, courseId);
    expect(courseRouteSnapshotSchema.safeParse(response).success, label).toBe(true);
    const client = createCourseRouteClient(async () => new Response(JSON.stringify(response), { status: 200 }));
    const snapshot = await client.read(courseId), progress = snapshot.requirements[0]!;
    expect(snapshot.summary, label).toEqual({ total: 3, mandatory: 3, verified: 0, blocked: sourcesAvailable ? 0 : 3 });
    expect(progress.sourcesAvailable, label).toBe(sourcesAvailable);
    expect(progress.compilation, label).toMatchObject({ saved, activityId: start.kind === "ready" ? start.activity.id : "", contentVersion: 1,
      documentId: saved ? spec.documentId : null, revisionNumber: saved ? spec.revisionNumber : null, verificationStatus: saved ? "needs_check" : null });
    expect(progress.questionCoverage, label).toEqual({ savedQuestions: saved ? 1 : 0, withReferenceAnswers: saved ? 1 : 0, issuedQuestions: 0, unexposedEligibility: "unknown" });
    expect(progress.referenceChecks, label).toEqual({ matched: saved ? 1 : 0, mismatched: 0, unsupported: 0 });
    expect(progress.status, label).toBe(sourcesAvailable ? "unobserved" : "blocked");
    const host = document.createElement("div"), root = createRoot(host);
    document.body.append(host);
    try {
      await act(async () => root.render(createElement(CourseRoutePanel, { courseId, client,
        goalsClient: { list: async () => ({ goals: [], selectedGoalIds: {}, legacyConflicts: [] }) } })));
      const items = [...host.querySelectorAll("li")].filter(row => row.querySelector("h3"));
      expect(items, label).toHaveLength(3);
      expect(items[0]!.textContent, label).toContain(saved ? "讲义：已保存 · 待核对" : "尚无当前可用讲义");
      expect(items[0]!.textContent, label).toContain(`已保存题目 ${saved ? 1 : 0} 道 · 附参考解答 ${saved ? 1 : 0} 道`);
      expect(items[0]!.textContent, label).toContain(`程序算术核对：一致 ${saved ? 1 : 0} / 矛盾 0 / 不支持 0`);
      for (const item of items.slice(1)) expect(item.textContent).toContain("尚无当前匹配活动");
    } finally { await act(async () => root.unmount()); host.remove(); }
    expect(await scopeContents(), label).toBe(before);
    console.info(label, `saved=${saved}, sourcesAvailable=${sourcesAvailable}; full scoped rows unchanged`);
  }
  async function refs(refs: TeachingSourceRef[]) {
    const input = { activityId: start.kind === "ready" ? start.activity.id : "", teachingUnitId: unit.id, expectedVersion: 1,
      revisionNumber: revision.revisionNumber, blockOrder: spec.blockOrder, sourceRefs: refs, verificationStatus: "needs_check" };
    expect(activitySpecPublishInputSchema.safeParse(input).success).toBe(true);
    await sql`UPDATE opening_teaching_activity_specs SET source_refs=${sql.json(refs)} WHERE activity_id=${start.kind === "ready" ? start.activity.id : ""} AND workspace_id=${scope.workspaceId}`;
  }
  await check("published exact chunk and page", true);
  await refs([{ ...sourceRef, chunkId, page: 2 }]);
  await check("wrong page cannot fall back to another same-source chunk on that page", false);
  await refs([{ ...sourceRef, chunkId }]);
  await check("chunk-only valid", true);
  await refs([{ ...sourceRef, page: 2 }]);
  await check("page-only valid", true);
  await refs([{ ...sourceRef, page: 999 }]);
  await check("page-only missing", false);
  await refs([{ ...sourceRef, chunkId: foreignChunkId }]);
  await check("chunk belongs to another legal course source", false);
  await refs([{ ...sourceRef, chunkId: oldVersionChunkId }]);
  await check("chunk belongs to another version", false);
  await refs([{ ...sourceRef, chunkId: "model-generated-not-a-uuid" }]);
  await check("arbitrary model chunk string returns unavailable, not a SQL cast error", false);
  await refs([sourceRef, { ...sourceRef, chunkId, page: 2 }]);
  await check("every ref must match, even with a valid whole-source ref", false);
  await refs([{ ...sourceRef, chunkId }]);
  await sql`DELETE FROM opening_source_chunks WHERE id=${chunkId}`;
  await check("deleted chunk does not fall back to remaining source chunks", false);
  await refs([sourceRef]);
  await check("whole-source ref needs no specific chunk or page", true);
  await rows.exclude(sourceId);
  await check("privacy exclusion still invalidates saved material", false, false);
});
