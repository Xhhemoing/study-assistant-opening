// @vitest-environment jsdom
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { activitySpecPublishInputSchema, courseRouteSnapshotSchema, type CourseRouteRequirementInput, type TeachingBlockRef } from "@aistudy/contracts";
import { createOpeningLearningGoalRepository, createOpeningTeachingContentRepository, createSqlClient } from "@aistudy/database";
import { createOpeningCourseRouteRepository } from "../../packages/database/src/repositories/opening-course-route";
import { assertOpeningTestDatabase } from "@aistudy/config";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { CourseRoutePanel } from "../../apps/web/src/features/opening/courses/course-route-panel";
import { createCourseRouteClient } from "../../apps/web/src/features/opening/courses/course-route-client";
import { backupRows } from "./opening-backup-records-fixture";

let sql: ReturnType<typeof createSqlClient>;
const scope = { workspaceId: randomUUID(), ownerUserId: randomUUID() };
beforeEach(async () => {
  sql = createSqlClient(assertOpeningTestDatabase(process.env.OPENING_TEST_DATABASE_URL ?? "", process.env.OPENING_TEST_DB).toString());
  await sql`INSERT INTO users(id,email,display_name,password_hash) VALUES(${scope.ownerUserId},${scope.ownerUserId + "@example.com"},'Reference checks','test')`;
  await sql`INSERT INTO workspaces(id,owner_user_id) VALUES(${scope.workspaceId},${scope.ownerUserId})`;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(async () => { vi.unstubAllGlobals(); await sql?.end({ timeout: 5 }); });

// Compare full rows in every scoped table across the read/client/render chain.
async function workspaceContents() {
  const tables = await sql`SELECT table_name FROM information_schema.columns
    WHERE table_schema='public' AND column_name='workspace_id' ORDER BY table_name`;
  const result: Record<string, unknown> = {};
  for (const table of tables) result[String(table.table_name)] = await sql`SELECT to_jsonb(t) AS row FROM ${sql(String(table.table_name))} t
    WHERE workspace_id=${scope.workspaceId} ORDER BY to_jsonb(t)::text`;
  return JSON.stringify(result);
}
it("checks only current legally published references through repository → strict client → panel without writes", async () => {
  const courseId = randomUUID(), rows = backupRows(sql, scope), sourceId = await rows.source("uploaded", 1), chunkId = await rows.chunk(sourceId, 1);
  await sql`UPDATE opening_source_chunks SET image_object_key=NULL,text='有理数运算' WHERE id=${chunkId}`;
  await sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${courseId},${scope.workspaceId},'Reference checks',${courseId})`;
  await sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,visibility) VALUES(${scope.workspaceId},${courseId},'source',${sourceId},'core','course')`;
  const goal = await createOpeningLearningGoalRepository(sql).create(scope, { clientKey: randomUUID(), courseIds: [courseId], title: "运算", kind: "custom", targetDate: null, examDate: null, weeklyMinutes: 120, priority: 1, learningMode: "understand", successCriteria: "独立计算" });
  const requirement: CourseRouteRequirementInput = { id: randomUUID(), stableSkillId: randomUUID(), knowledgeNodeId: null, requirementKey: "arithmetic", title: "运算要求", position: 0, mandatory: true, goalIds: [goal.id], prerequisiteIds: [], sourceRefs: [{ sourceId, sourceVersion: 1, chunkId }], verification: { kind: "rubric", status: "ready", exerciseKeys: ["arithmetic"], rubric: "精确运算", missingReasons: [] }, origin: "confirmed" };
  const repo = createOpeningCourseRouteRepository(sql, { compilerEnabled: true });
  await repo.confirm(scope, courseId, { expectedRevisions: [], requirements: [requirement], confirmScope: true });
  const start = await repo.start(scope, courseId, { goalId: goal.id, expectedGoalRevision: 1, requirementId: requirement.id, expectedRequirementRevision: 1, clientKey: randomUUID(), minutes: 20 });
  if (start.kind !== "ready") throw new Error(JSON.stringify(start));
  const content = createOpeningTeachingContentRepository(sql);
  const unit = await content.createUnit(scope, { title: "人工保存的运算讲义", blocks: [{ id: randomUUID(), type: "text", content: { text: "初始讲义" } }] });
  const block = (type: string, text: string, extra: Record<string, unknown> = {}) => ({ id: randomUUID(), type, content: { text, ...extra } });
  async function publish(blocks: ReturnType<typeof block>[], expectedVersion: number) {
    const revision = await content.writeUnitBlocks(scope, unit.id, blocks);
    const blockOrder: TeachingBlockRef[] = blocks.map((b, position) => ({ blockId: b.id, blockType: b.type, role: ["answer_key", "solution"].includes(b.type) ? "answer_key" : b.type === "prompt" ? "prompt" : "teach", position }));
    return content.publishActivitySpec(scope, activitySpecPublishInputSchema.parse({ activityId: start.kind === "ready" ? start.activity.id : "", teachingUnitId: unit.id,
      expectedVersion, revisionNumber: revision.revisionNumber, blockOrder, sourceRefs: [{ sourceId, version: 1, chunkId }], verificationStatus: "needs_check" }));
  }
  // Real append-only revision, then a legal CAS publication simulating a historical/manual edit.
  const oldBlocks = [block("prompt", "计算：17 + 19"), block("answer_key", "36")];
  const oldSpec = await publish(oldBlocks, 0);
  expect((await repo.read(scope, courseId)).requirements[0]!.referenceChecks).toEqual({ matched: 1, mismatched: 0, unsupported: 0 });
  const blocks = [
    block("prompt", "计算：1/3 + 1/6"), block("solution", "1/3 + 1/6 = 1/2"),
    block("prompt", "计算：8 - 3"), block("answer_key", "8 - 3 = 6"),
    block("prompt", "说明为什么加法交换律成立"), block("answer_key", "从定义解释"),
    block("prompt", "计算：2 + 2", { interaction: { kind: "choice", options: [{ id: "A", label: "4" }, { id: "B", label: "5" }] } }), block("answer_key", "A"),
    block("prompt", "计算：3 + 4", { interaction: { kind: "numeric", unit: "米" } }), block("answer_key", "7"),
    block("prompt", "计算：11 + 12"), block("text", "此题尚无参考解答"), block("answer_key", "23"),
  ];
  const spec = await publish(blocks, 1);
  expect(spec.version).toBe(2);
  expect(spec.revisionNumber).toBeGreaterThan(oldSpec.revisionNumber);
  const before = await workspaceContents();
  const response = await repo.read(scope, courseId);
  expect(courseRouteSnapshotSchema.safeParse(response).success).toBe(true);
  const client = createCourseRouteClient(async () => new Response(JSON.stringify(response), { status: 200 }));
  const snapshot = await client.read(courseId), progress = snapshot.requirements[0]!;
  expect(progress.referenceChecks).toEqual({ matched: 1, mismatched: 1, unsupported: 3 });
  expect(progress.questionCoverage).toEqual({ savedQuestions: 6, withReferenceAnswers: 5, issuedQuestions: 0, unexposedEligibility: "unknown" });
  expect(progress.compilation).toMatchObject({ saved: true, contentVersion: 2, revisionNumber: spec.revisionNumber, verificationStatus: "needs_check" });
  expect(progress.status).toBe("unobserved");
  expect(snapshot.summary.verified).toBe(0);
  const serialized = JSON.stringify(response);
  for (const b of [...blocks, ...oldBlocks]) {
    expect(serialized).not.toContain(b.id);
    expect(serialized).not.toContain(JSON.stringify(b.content.text));
  }
  const host = document.createElement("div"), root = createRoot(host);
  document.body.append(host);
  try {
    await act(async () => root.render(createElement(CourseRoutePanel, { courseId, client,
      goalsClient: { list: async () => ({ goals: [], selectedGoalIds: {}, legacyConflicts: [] }) } })));
    expect(host.textContent).toContain("程序算术核对：一致 1 / 矛盾 1 / 不支持 3");
    expect(host.textContent).toContain("已保存题目 6 道 · 附参考解答 5 道");
    expect(host.textContent).toContain("未暴露资格未确认");
    expect(host.textContent).toContain("讲义：已保存 · 待核对");
    expect(host.textContent).toContain("待开始");
    for (const b of blocks) expect(host.textContent).not.toContain(b.content.text);
  } finally { await act(async () => root.unmount()); host.remove(); }
  expect(await workspaceContents()).toBe(before);
  console.info("reference checks PG→strict client→panel", JSON.stringify(progress.referenceChecks), "full scoped rows unchanged");
  // Removing the contradictory pair via a new revision removes that contradiction, not merely its display.
  await publish([blocks[0]!, blocks[1]!], 2);
  const finalBefore = await workspaceContents();
  const final = await repo.read(scope, courseId);
  expect(final.requirements[0]!.referenceChecks).toEqual({ matched: 1, mismatched: 0, unsupported: 0 });
  expect(final.requirements[0]!.questionCoverage).toEqual({ savedQuestions: 1, withReferenceAnswers: 1, issuedQuestions: 0, unexposedEligibility: "unknown" });
  expect(await workspaceContents()).toBe(finalBefore);
});
