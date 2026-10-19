import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createOpeningConversationRepository, createOpeningPrivacyRepository, createOpeningTutorJobsRepository, readOpeningSystemQueryAuthorization } from "@aistudy/database";
import type { ProviderInput, ProviderOutput, SystemQueryRequest } from "@aistudy/contracts";
import { createDbSystemQueryService } from "../../apps/worker/src/runtime/system-query";
import { createTutorTurnHandler } from "../../apps/worker/src/jobs/tutor-turn";
import { getEphemeralTutorService } from "../../apps/web/src/features/opening/runtime";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { backupRows } from "./opening-backup-records-fixture";
let fixture: OpeningFixture;
const forbidden = vi.fn(async (): Promise<never> => { throw new Error("unexpected provider/RAG/budget call"); });
const modelOutput = (request?: SystemQueryRequest): ProviderOutput => ({ text: "MODEL_UNTRUSTED_ANSWER", citedChunkIds: [], candidates: [], inputTokens: 1, outputTokens: 1, requestId: null,
  ...(request ? { toolCalls: [{ id: randomUUID(), name: request.name, arguments: JSON.stringify(request.arguments) }] } : {}) });
const ephemeral = (text: string) => ({ querySystem: true, text, sourceIds: [], mode: "listen" as const, history: [] });
beforeEach(async () => { fixture = await createOpeningFixture(); vi.stubEnv("OPENING_SYSTEM_QUERY", "1"); vi.stubEnv("OPENING_MODEL_API_KEY", ""); vi.stubEnv("OPENING_MODEL_CATALOG", "invalid catalog"); forbidden.mockClear(); vi.stubGlobal("fetch", forbidden); });
afterEach(async () => {
  vi.unstubAllEnvs(); vi.unstubAllGlobals();
  try {
    const scopes = [fixture.scope.workspaceId, fixture.otherScope.workspaceId], users = [fixture.scope.ownerUserId, fixture.otherScope.ownerUserId];
    await fixture.sql`DELETE FROM courses WHERE workspace_id=ANY(${scopes}::uuid[])`;
    await fixture.sql`DELETE FROM workspaces WHERE id=ANY(${scopes}::uuid[])`;
    await fixture.sql`DELETE FROM sessions WHERE user_id=ANY(${users}::uuid[])`;
    await fixture.sql`DELETE FROM users WHERE id=ANY(${users}::uuid[])`;
  } finally { await fixture.close(); }
});
async function courses() {
  const a = randomUUID(), b = randomUUID();
  await fixture.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES (${a},${fixture.scope.workspaceId},'数学甲',${a}),(${b},${fixture.scope.workspaceId},'物理乙',${b})`;
  return { a, b };
}

it.each(["明天的计划", "明日安排", "tomorrow plan"])("resolves %s to the workspace calendar day instead of today's saved plan", async text => {
  await fixture.sql`INSERT INTO workspace_preferences(workspace_id,planning_settings) VALUES (${fixture.scope.workspaceId},'{"timeZone":"Pacific/Honolulu"}'::jsonb)`;
  const { clock } = await readOpeningSystemQueryAuthorization(fixture.sql, fixture.scope), next = new Date(`${clock.today}T12:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
  const tomorrow = next.toISOString().slice(0, 10);
  await fixture.sql`INSERT INTO opening_plan_state(workspace_id,day,accepted_version,accepted_blocks) VALUES
    (${fixture.scope.workspaceId},${clock.today},11,'[]'::jsonb),(${fixture.scope.workspaceId},${tomorrow},22,'[]'::jsonb)`;
  const result = await createDbSystemQueryService(fixture.sql, "web").reply(fixture.scope, { question: text });
  expect(result.receipt.results[0]).toMatchObject({ name: "planning", data: [{ date: tomorrow, acceptedVersion: 22, timeZone: "Pacific/Honolulu" }] });
  expect(result.text).not.toContain("MODEL_UNTRUSTED_ANSWER"); expect(forbidden).not.toHaveBeenCalled();
});
it.each(["下周的计划", "周一安排", "2026-02-30计划", "我有哪些任务", "我有哪些计划"])("asks for clarification for %s without substituting another domain/day", async text => {
  const result = await getEphemeralTutorService(fixture.sql).replyEphemeral(fixture.scope, ephemeral(text));
  expect(result.systemQuery).toMatchObject({ status: "unknown", clarification: expect.any(String) });
  expect(result.systemQuery!.results.every(row => row.name === "rejected" && row.data.length === 0)).toBe(true); expect(forbidden).not.toHaveBeenCalled();
});
it.each(["我的后台任务有哪些", "解析进度怎样", "后台处理完成了吗"])("routes %s to actual job records instead of learning completion", async text => {
  const id = randomUUID();
  await fixture.sql`INSERT INTO opening_jobs(id,workspace_id,owner_user_id,key,kind,payload,state)
    VALUES (${id},${fixture.scope.workspaceId},${fixture.scope.ownerUserId},${id},'parse','{}'::jsonb,'succeeded')`;
  const result = await createDbSystemQueryService(fixture.sql, "web").reply(fixture.scope, { question: text });
  expect(result.receipt.results[0]).toMatchObject({ name: "jobs", data: [expect.objectContaining({ id, status: "succeeded" })] });
  expect(result.text).toContain("不能证明内容质量或学习效果"); expect(forbidden).not.toHaveBeenCalled();
});
it("resolves a named course from real candidates, while asking for an ambiguous course or multiple selected materials", async () => {
  await courses(); const service = createDbSystemQueryService(fixture.sql, "web");
  const ambiguous = await service.reply(fixture.scope, { question: "我现在学到哪里" });
  expect(ambiguous.receipt.clarification).toContain("课程"); expect(ambiguous.receipt.results.map(row => row.name)).toEqual(["courses"]);
  const selected = await service.reply(fixture.scope, { question: "数学甲的学习进度" });
  expect(selected.receipt.clarification).toBeUndefined(); expect(selected.receipt.results.map(row => row.name)).toEqual(["courses", "learning"]);
  const material = await service.reply(fixture.scope, { question: "材料在哪页", focus: { sourceIds: [randomUUID(), randomUUID()] } });
  expect(material.receipt.clarification).toContain("多份材料"); expect(material.receipt.results[0]!.data).toEqual([]);
});
it("uses the injected PR69 planner through ephemeral runtime with real scoped reads and two rounds", async () => {
  const { a } = await courses();
  const planner = vi.fn(async (input: ProviderInput, round: number) => {
    expect(input.history).toBeUndefined(); expect(input.text).toContain("timeZone");
    if (round === 0) return modelOutput({ name: "courses", arguments: { limit: 5, offset: 0 } });
    expect(input.toolMessages![1]).toMatchObject({ role: "tool", text: expect.stringContaining("数学甲") });
    return modelOutput({ name: "learning", arguments: { courseId: a, limit: 5, offset: 0 } });
  });
  const reply = await getEphemeralTutorService(fixture.sql, { queryPlanner: planner }).replyEphemeral(fixture.scope, ephemeral("数学甲的学习进度"));
  expect(reply.systemQuery).toMatchObject({ mode: "native_tools" }); expect(reply.systemQuery!.results.map(row => row.name)).toEqual(["courses", "learning"]);
  expect(planner).toHaveBeenCalledTimes(2); expect(reply.text).not.toContain("MODEL_UNTRUSTED_ANSWER"); expect(forbidden).not.toHaveBeenCalled();
});
it("rejects a mock planner substituting today for tomorrow or guessing a course from ambiguous candidates", async () => {
  const { a } = await courses(), { clock } = await readOpeningSystemQueryAuthorization(fixture.sql, fixture.scope);
  const datePlanner = vi.fn(async () => modelOutput({ name: "planning", arguments: { date: clock.today, limit: 5, offset: 0 } }));
  const date = await createDbSystemQueryService(fixture.sql, "web", { planner: datePlanner }).reply(fixture.scope, { question: "明天的计划" });
  expect(date.receipt.clarification).toContain("不一致"); expect(date.receipt.results[0]).toMatchObject({ reason: "clarification_required", data: [] });
  const guessed = await createDbSystemQueryService(fixture.sql, "web", { planner: async (_input, round) => modelOutput(round === 0
    ? { name: "courses", arguments: { limit: 5, offset: 0 } } : { name: "learning", arguments: { courseId: a, limit: 5, offset: 0 } }) }).reply(fixture.scope, { question: "我现在学到哪里" });
  expect(guessed.receipt.clarification).toContain("课程"); expect(guessed.receipt.results[1]).toMatchObject({ reason: "clarification_required", data: [] }); expect(forbidden).not.toHaveBeenCalled();
  const pageGuess = await createDbSystemQueryService(fixture.sql, "web", { planner: async (_input, round) => modelOutput(round === 0
    ? { name: "courses", arguments: { limit: 5, offset: 1 } } : { name: "learning", arguments: { courseId: a, limit: 5, offset: 0 } }) }).reply(fixture.scope, { question: "我现在学到哪里" });
  expect(pageGuess.receipt.clarification).toContain("课程");
  expect(pageGuess.receipt.results[1]).toMatchObject({ reason: "clarification_required", data: [] });
});
it("runs saved query jobs with the injected planner without entering ordinary provider, RAG or budget", async () => {
  const { a, b } = await courses(), repo = createOpeningConversationRepository(fixture.sql), conversation = await repo.create(fixture.scope, { title: "Native protocol", courseId: a });
  const saved = await repo.appendSavedTurn({ scope: fixture.scope, conversationId: conversation.id, querySystem: true, text: "我的作答核验了吗", mode: "listen", clientKey: randomUUID(), sourceIds: [], learningSessionId: null, currentPage: null, chunkId: null });
  const planner = vi.fn(async () => modelOutput({ name: "learning", arguments: { courseId: b, limit: 5, offset: 0 } }));
  const handler = createTutorTurnHandler({ systemQuery: createDbSystemQueryService(fixture.sql, "worker", { planner }), tutorJobs: createOpeningTutorJobsRepository(fixture.sql),
    provider: { complete: forbidden }, resolveModel: forbidden, chunks: { listForSources: forbidden, listChunksAtVersion: forbidden }, privacy: createOpeningPrivacyRepository(fixture.sql),
    budget: { reserve: forbidden, release: forbidden, claimExecution: forbidden, settle: forbidden, markUnknown: forbidden },
    config: { maxContextCharacters: 12000, reservedCents: 1, maxOutputTokens: 100, inputCentsPerMillion: 1, outputCentsPerMillion: 1 } });
  await handler(saved.jobId);
  const turn = (await repo.listTurns(fixture.scope, conversation.id)).find(row => row.role === "assistant")!;
  expect(turn.systemQuery!.clarification).toContain("课程"); expect(turn.systemQuery!.results[0]!.data).toEqual([]); expect(planner).toHaveBeenCalledTimes(1); expect(forbidden).not.toHaveBeenCalled();
});
it("does not allow a planner to substitute an unselected source", async () => {
  const rows = backupRows(fixture.sql, fixture.scope), a = await rows.source(), b = await rows.source(); await rows.chunk(a); await rows.chunk(b);
  const reply = await createDbSystemQueryService(fixture.sql, "web", { planner: async () => modelOutput({ name: "materials", arguments: { sourceId: b, limit: 5, offset: 0 } }) })
    .reply(fixture.scope, { question: "材料在哪页", focus: { sourceId: a, sourceIds: [a] } });
  expect(reply.receipt.clarification).toContain("材料"); expect(reply.receipt.results[0]!.data).toEqual([]); expect(forbidden).not.toHaveBeenCalled();
});
it("retains the captured source version when a mock planner omits it instead of filling in today's version", async () => {
  const rows = backupRows(fixture.sql, fixture.scope), sourceId = await rows.source(); await rows.chunk(sourceId);
  await fixture.sql`UPDATE opening_sources SET version=2 WHERE id=${sourceId}`;
  const reply = await createDbSystemQueryService(fixture.sql, "web", { planner: async () => modelOutput({ name: "materials", arguments: { sourceId, limit: 5, offset: 0 } }) })
    .reply(fixture.scope, { question: "材料在哪页", focus: { sourceId, sourceIds: [sourceId], sourceVersion: 1, physicalPage: 1 } });
  expect(reply.receipt.results[0]).toMatchObject({ reason: "stale", data: [], sourceRefs: [] });
  expect(reply.receipt.results.flatMap(result => result.sourceRefs)).toEqual([]); expect(forbidden).not.toHaveBeenCalled();
});
it.each([false, true])("rejects model-filtered courses(B) through the complete engine (bound=%s)", async bound => {
  const { a, b } = await courses();
  const planner = vi.fn(async (_input: ProviderInput, round: number) => modelOutput(round === 0
    ? { name: "courses", arguments: { courseId: b, limit: 5, offset: 0 } } : { name: "learning", arguments: { courseId: b, limit: 5, offset: 0 } }));
  const reply = await createDbSystemQueryService(fixture.sql, "web", { planner }).reply(fixture.scope, { question: "我现在学到哪里", focus: bound ? { courseId: a } : undefined });
  expect(planner).toHaveBeenCalledTimes(1); expect(reply.receipt.results).toMatchObject([{ name: "courses", reason: "clarification_required", data: [] }]);
  expect(reply.text).not.toContain("物理乙"); expect(forbidden).not.toHaveBeenCalled();
});
it.each([0, 1])("does not promote a paginated one-source candidate into user selection through the complete engine (offset=%s)", async offset => {
  const rows = backupRows(fixture.sql, fixture.scope), a = await rows.source(), b = await rows.source(); await rows.chunk(a); await rows.chunk(b);
  const planner = vi.fn(async (_input: ProviderInput, round: number) => modelOutput(round === 0
    ? { name: "materials", arguments: { query: "source evidence", limit: 1, offset } } : { name: "materials", arguments: { sourceId: a, limit: 5, offset: 0 } }));
  const reply = await createDbSystemQueryService(fixture.sql, "web", { planner }).reply(fixture.scope, { question: "材料“source evidence”在哪页" });
  expect(planner).toHaveBeenCalledTimes(1); expect(reply.receipt.results).toHaveLength(1); expect(reply.receipt.clarification).toContain("完整");
  expect(reply.receipt.results[0]!.data).toHaveLength(1); expect(forbidden).not.toHaveBeenCalled();
});
