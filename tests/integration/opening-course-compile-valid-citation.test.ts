import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { CourseRouteRequirementInput, TeachingActivity } from "@aistudy/contracts";
import {
  createOpeningBudgetRepository, createOpeningPrivacyRepository, createOpeningSourceChunksRepository,
  createOpeningTeachingActivitiesRepository, createOpeningTeachingContentRepository,
  createOpeningCourseRouteRepository, createOpeningLearningGoalRepository, createOpeningJobRepository,
} from "@aistudy/database";
import { createCompileTeachingUnitHandler } from "../../apps/worker/src/jobs/compile-teaching-unit";
import { createCompileTeachingUnitWorkerDeps } from "../../apps/worker/src/runtime/compile-teaching-unit-wiring";
import { rankPedagogy } from "../fixtures/opening/teaching/rank-pedagogy";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

let f: OpeningFixture;
let citations: string[] = [];
const requests: Array<{ messages: Array<{ content: string }> }> = [];
const explanation = "矩阵的秩与零空间维数之和等于列数。";
const server = createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
  const body: Buffer[] = [];
  for await (const chunk of request) body.push(Buffer.from(chunk));
  requests.push(JSON.parse(Buffer.concat(body).toString("utf8")));
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
    id: "citation-fixture", choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ blocks: [
      { type: "text", text: explanation, citedChunkIds: citations },
      ...[5, 4].flatMap(columns => [
        { type: "prompt", text: `一个3×${columns}矩阵的秩为2，零空间维数是多少？` },
        { type: "answer_key", ...rankPedagogy, text: `${columns} − 2 = ${columns - 2}`,
          hints: { direction: "先找列数。", concept: explanation, firstStep: `用${columns}减去2。` } },
      ]),
    ] }) } }], usage: { prompt_tokens: 100, completion_tokens: 100 },
  }));
});
beforeAll(async () => {
  f = await createOpeningFixture();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
});
beforeEach(async () => {
  await f.reset(); requests.length = 0; citations = [];
  for (const [name, value] of Object.entries({
    OPENING_TEACHING_COMPILER_ENABLED: "1", OPENING_TEACHING_VALIDATION_ENABLED: "0", OPENING_PROVIDER_ALLOW_LOCAL: "1",
    OPENING_MODEL_API_KEY: "test-citation-key", OPENING_MODEL_DAILY_CAP_CENTS: "100000", OPENING_MODEL_DEFAULT_ID: "citation-model",
    OPENING_MODEL_CATALOG: JSON.stringify([{ id: "citation-model", label: "Citation fixture", providerId: "citation-provider", providerLabel: "Fixture",
      modelName: "citation-model", apiKeyEnv: "OPENING_MODEL_API_KEY", baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      inputCentsPerMillion: 10000, outputCentsPerMillion: 10000 }]),
  })) vi.stubEnv(name, value);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(async () => {
  await f?.close();
  if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});
function deps() {
  return createCompileTeachingUnitWorkerDeps(f.sql, { budget: createOpeningBudgetRepository(f.sql, { envCapCents: 100_000 }),
    chunks: createOpeningSourceChunksRepository(f.sql), privacy: createOpeningPrivacyRepository(f.sql) });
}
async function seed() {
  const courseId = randomUUID(), sourceId = randomUUID(), chunkId = randomUUID();
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES (${courseId},${f.scope.workspaceId},'矩阵秩',${courseId})`;
  await f.sql`INSERT INTO opening_sources(id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state)
    VALUES (${sourceId},${f.scope.workspaceId},'矩阵秩','text/plain',1,${"c".repeat(64)},1,'uploaded','ready')`;
  await f.sql`INSERT INTO opening_source_chunks(id,source_id,source_version,page,text) VALUES (${chunkId},${sourceId},1,1,${explanation})`;
  await f.sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,visibility)
    VALUES (${f.scope.workspaceId},${courseId},'source',${sourceId},'core','course')`;
  const goal = await createOpeningLearningGoalRepository(f.sql).create(f.scope, { clientKey: randomUUID(), courseIds: [courseId], title: "掌握全课",
    kind: "custom", targetDate: null, examDate: null, weeklyMinutes: 120, priority: 1, learningMode: "understand", successCriteria: "按材料解释" });
  const requirements: CourseRouteRequirementInput[] = [0, 1].map(position => ({ id: randomUUID(), stableSkillId: randomUUID(), knowledgeNodeId: null,
    requirementKey: `rank-${position}`, title: `矩阵秩${position}`, position, mandatory: true, goalIds: [goal.id], prerequisiteIds: [],
    sourceRefs: [{ sourceId, sourceVersion: 1, page: 1, chunkId }],
    verification: { kind: "rubric", status: "ready", exerciseKeys: ["rank"], rubric: explanation, missingReasons: [] }, origin: "confirmed" }));
  const route = createOpeningCourseRouteRepository(f.sql, { compilerEnabled: true });
  await route.confirm(f.scope, courseId, { expectedRevisions: [], requirements, confirmScope: true });
  const started = await route.start(f.scope, courseId, { goalId: goal.id, expectedGoalRevision: 1, requirementId: requirements[0]!.id,
    expectedRequirementRevision: 1, clientKey: randomUUID(), minutes: 20 });
  if (started.kind !== "ready") throw new Error(JSON.stringify(started));
  return { courseId, sourceId, chunkId, route, activity: started.activity };
}
async function oldContent(activity: TeachingActivity) {
  const content = createOpeningTeachingContentRepository(f.sql), blockId = randomUUID();
  const unit = await content.createUnit(f.scope, { title: "合法旧正文", blocks: [{ id: blockId, type: "text", content: { text: "保留原来的合法讲解。" } }] });
  await content.publishActivitySpec(f.scope, { activityId: activity.id, teachingUnitId: unit.id, expectedVersion: 0, revisionNumber: 1,
    blockOrder: [{ blockId, blockType: "text", role: "teach", position: 0 }], verificationStatus: "needs_check", sourceRefs: [] });
  return { content, unit };
}
async function run(activity: TeachingActivity, unitId: string) {
  const [row] = await f.sql`SELECT id FROM opening_jobs WHERE workspace_id=${f.scope.workspaceId} AND kind='compile-teaching-unit' AND payload->>'activityId'=${activity.id}`;
  const job = await createOpeningJobRepository(f.sql).claim(String(row!.id));
  expect(job).not.toBeNull();
  return createCompileTeachingUnitHandler(deps())(job!, { ...job!.payload as object, teachingUnitId: unitId, expectedContentVersion: 1 });
}
it("rejects all-wrong citations via HTTP without changing old bodies, revisions, pins or content version", async () => {
  const x = await seed(), { content, unit } = await oldContent(x.activity);
  const before = await content.getClientInit(f.scope, x.activity.id);
  const revisions = await f.sql`SELECT * FROM library_revisions WHERE document_id=${unit.documentId} ORDER BY revision_number`;
  expect(JSON.stringify(before)).toContain("保留原来的合法讲解。");
  citations = [randomUUID()];
  await expect(run(x.activity, unit.id)).rejects.toMatchObject({ code: "TEACHING_COMPILE_OUTPUT" });
  expect(requests).toHaveLength(1);
  expect(requests[0]!.messages.map(message => message.content).join("\n")).toContain(x.chunkId);
  expect((await createOpeningTeachingActivitiesRepository(f.sql).get(f.scope, x.activity.id))?.generateStatus).toBe("failed");
  expect(await content.getClientInit(f.scope, x.activity.id)).toEqual(before);
  expect(await f.sql`SELECT * FROM library_revisions WHERE document_id=${unit.documentId} ORDER BY revision_number`).toEqual(revisions);
});
it("writes valid material citations through HTTP, redacts hidden answers and saves the complete course denominator", async () => {
  const x = await seed(), { content, unit } = await oldContent(x.activity);
  citations = [x.chunkId];
  expect(await run(x.activity, unit.id)).toMatchObject({ generateStatus: "needs_check", verificationStatus: "needs_check" });
  expect(requests).toHaveLength(1);
  const spec = await content.getActivitySpec(f.scope, x.activity.id);
  expect(spec).toMatchObject({ version: 2, revisionNumber: 2, verificationStatus: "needs_check" });
  const revision = await content.readRevision(f.scope, unit.documentId, 2);
  expect(revision.blocks[0]).toMatchObject({ type: "text", content: { text: explanation, citedChunkIds: [x.chunkId] } });
  expect(revision.blocks.some(block => block.type === "answer_key" && block.content.answer === "5 − 2 = 3")).toBe(true);
  const client = await content.getClientInit(f.scope, x.activity.id);
  expect(JSON.stringify(client)).toContain(explanation);
  expect(JSON.stringify(client)).not.toContain("5 − 2 = 3");
  expect(client?.blocks.filter(block => block.role === "prompt")).toHaveLength(2);
  const route = await x.route.read(f.scope, x.courseId, x.activity.id);
  expect(route.summary).toMatchObject({ total: 2, mandatory: 2, verified: 0 });
  expect(route.requirements[0]).toMatchObject({ compilation: { saved: true, generateStatus: "needs_check", verificationStatus: "needs_check" }, status: "unobserved" });
  expect(route.requirements[1]?.status).toBe("unobserved");
});
it("preserves non-course no-material generation through the same HTTP worker factory", async () => {
  const activities = createOpeningTeachingActivitiesRepository(f.sql);
  const activity = await activities.create(f.scope, { clientKey: randomUUID(), intentKind: "topic", intentSummary: "矩阵秩", createIntent: { fixture: true } });
  await activities.setGenerateStatus(f.scope, activity.id, "queued");
  const { content, unit } = await oldContent(activity);
  const job = { id: randomUUID(), workspaceId: f.scope.workspaceId, ownerUserId: f.scope.ownerUserId, key: randomUUID(), kind: "compile-teaching-unit",
    payload: {}, result: null, state: "running", privacyEpoch: 0 };
  await createCompileTeachingUnitHandler(deps())(job, { mode: "generate", activityId: activity.id, teachingUnitId: unit.id,
    expectedContentVersion: 1, clientKey: randomUUID(), sourceIds: [] });
  expect(requests).toHaveLength(1);
  expect(await content.getActivitySpec(f.scope, activity.id)).toMatchObject({ version: 2, revisionNumber: 2 });
});
