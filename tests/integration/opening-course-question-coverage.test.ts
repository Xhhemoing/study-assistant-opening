// @vitest-environment jsdom
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { courseRouteSnapshotSchema, type CourseRouteRequirementInput, type TeachingActivity } from "@aistudy/contracts";
import { createOpeningLearningGoalRepository, createOpeningBudgetRepository, createOpeningSourceChunksRepository, createOpeningPrivacyRepository, createOpeningTeachingContentRepository, createOpeningJobRepository, createSqlClient, createOpeningLearningRepository, createOpeningLearningAttemptRepository } from "@aistudy/database";
import { createOpeningCourseRouteRepository } from "../../packages/database/src/repositories/opening-course-route";
import { createCompileTeachingUnitHandler } from "../../apps/worker/src/jobs/compile-teaching-unit";
import { createCompileTeachingUnitWorkerDeps } from "../../apps/worker/src/runtime/compile-teaching-unit-wiring";
import { assertOpeningTestDatabase } from "@aistudy/config";
import { act, createElement, type MouseEvent } from "react";
import { createRoot } from "react-dom/client";
import { CourseRoutePanel } from "../../apps/web/src/features/opening/courses/course-route-panel";
import { createCourseRouteClient } from "../../apps/web/src/features/opening/courses/course-route-client";
async function createOpeningFixture() {
  const sql = createSqlClient(assertOpeningTestDatabase(process.env.OPENING_TEST_DATABASE_URL ?? "", process.env.OPENING_TEST_DB).toString());
  const ownerUserId = randomUUID(), workspaceId = randomUUID();
  await sql`INSERT INTO users(id,email,display_name,password_hash) VALUES(${ownerUserId},${ownerUserId + "@example.com"},'Coverage fixture','test')`;
  await sql`INSERT INTO workspaces(id,owner_user_id) VALUES(${workspaceId},${ownerUserId})`;
  return { sql, scope: { workspaceId, ownerUserId }, close: () => sql.end({ timeout: 5 }) };
}
import { backupRows } from "./opening-backup-records-fixture";
import { rankPedagogy } from "../fixtures/opening/teaching/rank-pedagogy";
let f: Awaited<ReturnType<typeof createOpeningFixture>>;
beforeEach(async () => { f = await createOpeningFixture(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubEnv("OPENING_TEACHING_COMPILER_ENABLED", "1"); vi.stubEnv("OPENING_TEACHING_VALIDATION_ENABLED", "0"); });
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await f?.close(); });
async function seed() {
  const courseId = randomUUID(), rows = backupRows(f.sql, f.scope), sourceId = await rows.source("uploaded", 1), chunkId = await rows.chunk(sourceId, 1);
  await f.sql`UPDATE opening_source_chunks SET image_object_key=NULL,text='秩与零空间维数之和等于列数。' WHERE id=${chunkId}`;
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${courseId},${f.scope.workspaceId},'Compilation gaps',${courseId})`;
  await f.sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,visibility) VALUES(${f.scope.workspaceId},${courseId},'source',${sourceId},'core','course')`;
  const goal = await createOpeningLearningGoalRepository(f.sql).create(f.scope, { clientKey: randomUUID(), courseIds: [courseId], title: "全课", kind: "custom", targetDate: null, examDate: null, weeklyMinutes: 120, priority: 1, learningMode: "understand", successCriteria: "独立解释" });
  const requirements: CourseRouteRequirementInput[] = Array.from({ length: 3 }, (_, position) => ({ id: randomUUID(), stableSkillId: randomUUID(), knowledgeNodeId: null, requirementKey: `rank:${position}`, title: `秩${position}`, position, mandatory: true, goalIds: [goal.id], prerequisiteIds: [], sourceRefs: [{ sourceId, sourceVersion: 1, chunkId }], verification: { kind: "rubric", status: "ready", exerciseKeys: ["rank"], rubric: "列数减秩", missingReasons: [] }, origin: "confirmed" }));
  const repo = createOpeningCourseRouteRepository(f.sql, { compilerEnabled: true });
  await repo.confirm(f.scope, courseId, { expectedRevisions: [], requirements, confirmScope: true });
  async function start(index: number) {
    const result = await repo.start(f.scope, courseId, { goalId: goal.id, expectedGoalRevision: 1, requirementId: requirements[index]!.id, expectedRequirementRevision: 1, clientKey: randomUUID(), minutes: 20 });
    if (result.kind !== "ready") throw new Error(JSON.stringify(result));
    return result.activity;
  }
  return { repo, courseId, sourceId, requirements, start };
}
async function compile(activity: TeachingActivity) {
  const deps = createCompileTeachingUnitWorkerDeps(f.sql, { budget: createOpeningBudgetRepository(f.sql), chunks: createOpeningSourceChunksRepository(f.sql), privacy: createOpeningPrivacyRepository(f.sql) });
  // The production builder, library writer and publisher all run; only the external model is controlled.
  deps.callModel = async (_scope, input, options) => {
    await options.beforeSend?.();
    expect(input.chunks.length).toBeGreaterThan(0);
    return { text: JSON.stringify({ itemTitles: ["秩与零空间"], blocks: [
      { type: "text", text: "秩与零空间维数之和等于列数。", citedChunkIds: input.chunks.map(chunk => chunk.id) },
      { type: "prompt", text: "一个3×5矩阵的秩为2，零空间维数是多少？" },
      { type: "answer_key", ...rankPedagogy, text: "5 − 2 = 3", hints: { direction: "先找列数。", concept: "秩与零空间维数之和等于列数。", firstStep: "用5减去2。" } },
      { type: "text", text: "再换一个列数验证。" },
      { type: "prompt", text: "一个3×4矩阵的秩为2，零空间维数是多少？" },
      { type: "answer_key", ...rankPedagogy, text: "4 − 2 = 2", hints: { direction: "先找列数。", concept: "秩与零空间维数之和等于列数。", firstStep: "用4减去2。" } },
    ] }), citedChunkIds: [], requestId: null, candidates: [], inputTokens: 10, outputTokens: 10 };
  };
  const [row] = await f.sql`SELECT id FROM opening_jobs WHERE workspace_id=${f.scope.workspaceId} AND kind='compile-teaching-unit' AND payload->>'activityId'=${activity.id}`;
  const job = await createOpeningJobRepository(f.sql).claim(String(row!.id));
  if (!job) throw new Error("compile job not claimable");
  await createCompileTeachingUnitHandler(deps)(job, job.payload);
  const spec = await createOpeningTeachingContentRepository(f.sql).getActivitySpec(f.scope, activity.id);
  expect(spec).toMatchObject({ version: 1, verificationStatus: "needs_check" });
  return spec!;
}
// Compare every column of every workspace-scoped table, not just row counts.
async function workspaceContents() {
  const tables = await f.sql`SELECT table_name FROM information_schema.columns
    WHERE table_schema='public' AND column_name='workspace_id' ORDER BY table_name`;
  const result: Record<string, unknown> = {};
  for (const table of tables) {
    result[String(table.table_name)] = await f.sql`SELECT to_jsonb(t) AS row FROM ${f.sql(String(table.table_name))} t
      WHERE workspace_id=${f.scope.workspaceId} ORDER BY to_jsonb(t)::text`;
  }
  return JSON.stringify(result);
}
const zero = { savedQuestions: 0, withReferenceAnswers: 0, issuedQuestions: 0, unexposedEligibility: "unknown" };
it("opens a completed saved handout through repo → strict client → DOM without selecting a goal or writing", async () => {
  const x = await seed(), activity = await x.start(0), spec = await compile(activity);
  await x.start(1);
  await f.sql`UPDATE opening_teaching_activities SET status='completed' WHERE id=${activity.id} AND workspace_id=${f.scope.workspaceId}`;
  const before = await workspaceContents();
  const response = await x.repo.read(f.scope, x.courseId);
  expect(response.summary).toEqual({ total: 3, mandatory: 3, verified: 0, blocked: 0 });
  expect(response.requirements[0]!.compilation).toMatchObject({ saved: true, activityId: activity.id, documentId: spec.documentId, revisionNumber: spec.revisionNumber, contentVersion: 1, generateStatus: "needs_check", verificationStatus: "needs_check" });
  expect(response.requirements.map(row => row.questionCoverage)).toEqual([{ ...zero, savedQuestions: 2, withReferenceAnswers: 2 }, zero, zero]);
  const transport = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.method).toBe("GET");
    return new Response(JSON.stringify(response), { status: 200 });
  });
  const client = createCourseRouteClient(transport), start = vi.spyOn(client, "start"), confirm = vi.spyOn(client, "confirm");
  const clicked: string[] = [], host = document.createElement("div"), root = createRoot(host);
  document.body.append(host);
  try {
    await act(async () => root.render(createElement("div", { onClick: (event: MouseEvent<HTMLDivElement>) => {
      if (event.target instanceof HTMLAnchorElement) { event.preventDefault(); clicked.push(event.target.getAttribute("href")!); }
    } }, createElement(CourseRoutePanel, { courseId: x.courseId, client,
      goalsClient: { list: async () => ({ goals: [], selectedGoalIds: {}, legacyConflicts: [] }) } }))));
    const rows = [...host.querySelectorAll("li")].filter(row => row.querySelector("h3"));
    expect(rows).toHaveLength(3);
    expect(host.textContent).toContain("已确认 3 项要求，其中 3 项必修；0 项已有验证记录");
    expect(rows[0]!.textContent).toContain("已保存 · 待核对 · 待核对");
    expect(rows[1]!.textContent).toContain("排队中");
    expect(rows[2]!.textContent).toContain("尚无当前匹配活动");
    expect(rows.every(row => row.textContent?.includes("未暴露资格未确认"))).toBe(true);
    const links = [...host.querySelectorAll<HTMLAnchorElement>("a")].filter(link => link.textContent === "打开已保存讲义");
    expect(links).toHaveLength(1);
    expect(links[0]!.closest("li")).toBe(rows[0]);
    const href = `/opening/courses/${x.courseId}/study?activity=${activity.id}`;
    expect(links[0]!.getAttribute("href")).toBe(href);
    expect(host.querySelector("select")?.value).toBe("");
    expect([...host.querySelectorAll("button")].filter(button => button.textContent === "学习这一项").every(button => button.disabled)).toBe(true);
    await act(async () => links[0]!.click());
    expect(clicked).toEqual([href]);
    expect(start).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled();
    expect(transport).toHaveBeenCalledTimes(1);
    const init = await createOpeningTeachingContentRepository(f.sql).getClientInit(f.scope, new URL(clicked[0]!, "http://opening.local").searchParams.get("activity")!);
    expect(init).toMatchObject({ documentId: spec.documentId, revisionNumber: spec.revisionNumber, contentVersion: 1 });
    expect(JSON.stringify(init)).toContain("一个3×5矩阵");
    for (const answer of ["5 − 2 = 3", "4 − 2 = 2"]) {
      expect(JSON.stringify(init)).not.toContain(answer);
      expect(host.textContent).not.toContain(answer);
    }
    expect(host.textContent).not.toContain("已掌握");
  } finally { await act(async () => root.unmount()); host.remove(); }
  expect(await workspaceContents()).toBe(before);
});
it("carries real saved questions and issuance from confirm/start/publish through strict client into the panel without writes", async () => {
  const x = await seed(), activity = await x.start(0), spec = await compile(activity);
  await x.start(1);
  const prompts = spec.blockOrder.filter(ref => ref.role === "prompt");
  expect(prompts).toHaveLength(2);
  const session = await createOpeningLearningRepository(f.sql).createSession(f.scope, {
    courseId: x.courseId, activityId: activity.id, sourceIds: [x.sourceId], skillLabel: "秩",
  });
  const attempts = createOpeningLearningAttemptRepository(f.sql);
  const attempt = await attempts.create(f.scope, { sessionId: session.id, clientKey: randomUUID(),
    teachingBlock: { blockId: prompts[0]!.blockId, contentVersion: spec.version } });
  expect(attempt.itemVersionId).toBeTruthy();
  // Another attempt for the same question is still one issued question.
  await attempts.create(f.scope, { sessionId: session.id, clientKey: randomUUID(),
    teachingBlock: { blockId: prompts[0]!.blockId, contentVersion: spec.version } });
  const before = await workspaceContents();
  const response = await x.repo.read(f.scope, x.courseId);
  expect(courseRouteSnapshotSchema.safeParse(response).success).toBe(true);
  const transport = vi.fn(async () => new Response(JSON.stringify(response), { status: 200 }));
  const client = createCourseRouteClient(transport);
  const snapshot = await client.read(x.courseId);
  expect(snapshot.summary).toEqual({ total: 3, mandatory: 3, verified: 0, blocked: 0 });
  expect(snapshot.requirements.map(row => row.requirement)).toEqual(x.requirements.map(row => ({ ...row,
    courseId: x.courseId, revision: 1, lifecycle: "active", approvedAt: expect.any(String) })));
  expect(snapshot.requirements.map(row => row.questionCoverage)).toEqual([
    { savedQuestions: 2, withReferenceAnswers: 2, issuedQuestions: 1, unexposedEligibility: "unknown" }, zero, zero,
  ]);
  const host = document.createElement("div"), root = createRoot(host);
  document.body.append(host);
  try {
    await act(async () => root.render(createElement(CourseRoutePanel, { courseId: x.courseId, client,
      goalsClient: { list: async () => ({ goals: [], selectedGoalIds: {}, legacyConflicts: [] }) } })));
    const rows = [...host.querySelectorAll("li")].filter(row => row.querySelector("h3"));
    expect(rows).toHaveLength(3);
    expect(host.textContent).toContain("已确认 3 项要求，其中 3 项必修；0 项已有验证记录，0 项受阻。");
    expect(rows[0]!.textContent).toContain("已保存题目 2 道 · 附参考解答 2 道 · 曾发题 1 道 · 未暴露资格未确认");
    for (const row of rows.slice(1)) expect(row.textContent).toContain("已保存题目 0 道 · 附参考解答 0 道 · 曾发题 0 道 · 未暴露资格未确认");
    expect(rows[1]!.textContent).toContain("排队中");
    expect(rows[2]!.textContent).toContain("尚无当前匹配活动");
    expect(host.textContent).not.toContain("5 − 2 = 3");
    expect(host.textContent).not.toContain("一个3×5矩阵");
    expect(host.textContent).not.toContain("已掌握");
  } finally { await act(async () => root.unmount()); host.remove(); }
  expect(await workspaceContents()).toBe(before);
  expect(transport).toHaveBeenCalledTimes(2);
  console.info("question coverage PG→client→panel", JSON.stringify(snapshot.requirements.map(row => row.questionCoverage)));

  // A saved answer outside the current blockOrder cannot supply a reference answer.
  const answer = spec.blockOrder.find(ref => ref.role === "answer_key")!;
  await f.sql`UPDATE opening_teaching_activity_specs SET block_order=${f.sql.json(spec.blockOrder.filter(ref => ref.blockId !== answer.blockId))}
    WHERE activity_id=${activity.id} AND workspace_id=${f.scope.workspaceId}`;
  expect((await x.repo.read(f.scope, x.courseId)).requirements[0]!.questionCoverage).toEqual({ savedQuestions: 2, withReferenceAnswers: 1, issuedQuestions: 1, unexposedEligibility: "unknown" });
  // A same-name activity for an older requirement revision is not current output.
  await f.sql`UPDATE course_requirements SET revision=revision+1 WHERE id=${x.requirements[0]!.id}`;
  expect((await x.repo.read(f.scope, x.courseId)).requirements[0]!.questionCoverage).toEqual(zero);
});
