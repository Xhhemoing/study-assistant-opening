import { beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_OPENING_AI_SETTINGS, previousRecordQuestion, providerInputSchema, type SystemQueryRequest } from "@aistudy/contracts";
import type { Sql } from "postgres";
const fixture = vi.hoisted(() => ({ read: vi.fn(), grant: vi.fn(), call: vi.fn(), budget: {} }));
vi.mock("@aistudy/database", async importOriginal => ({ ...await importOriginal<typeof import("@aistudy/database")>(),
  readOpeningSystemQueryAuthorization: fixture.grant, createScopedOpeningSystemQueryReader: () => fixture.read,
  createOpeningBudgetRepository: () => fixture.budget,
}));
vi.mock("@aistudy/config", async importOriginal => ({ ...await importOriginal<typeof import("@aistudy/config")>(),
  loadFeatureSwitches: () => ({ systemQuery: true, adaptivePlanning: false, teachingLoop: { api: false } }),
  loadOpeningModelCatalog: () => ({ dailyCapCents: 10, models: [] }),
}));
vi.mock("./model-gateway", () => ({ createDbModelGateway: () => ({ call: fixture.call }), scopeBudget: () => fixture.budget }));
import { createDbSystemQueryService } from "./system-query";
const id = "00000000-0000-4000-8000-000000000001";
const scope = { workspaceId: id, ownerUserId: id }, authorization = { purpose: "system_record_lookup", workspaceId: id, principalId: id, role: "workspace_owner", permissionRevision: "owner:privacy:0" };
beforeEach(() => {
  vi.clearAllMocks(); fixture.grant.mockResolvedValue({ authorization, privacyEpoch: 0 });
  fixture.read.mockImplementation(async (request: SystemQueryRequest) => ({ name: request.name, authorization, status: "ok", reason: "read", asOf: new Date().toISOString(),
    version: "v1", data: [{ ...DEFAULT_OPENING_AI_SETTINGS, taskRoutes: {}, savedAt: null, summary: "已保存的设置" }], evidence: [], sourceRefs: [], nextOffset: null }));
});
it("production lazy gateway plans native reads using one parent budget and real schema boundaries", async () => {
  fixture.call.mockImplementationOnce(async (_scope, _task, options) => {
    expect(providerInputSchema.parse(options.input).tools?.map(tool => tool.name)).toEqual(["settings"]); await options.beforeSend();
    return { text: "不得展示的模型结论", inputTokens: 1, outputTokens: 1, citedChunkIds: [], candidates: [], requestId: null,
      toolCalls: [{ id: "read1", name: "settings", arguments: "{}" }] };
  }).mockResolvedValueOnce({ text: "ignored", citedChunkIds: [], candidates: [], inputTokens: 1, outputTokens: 1, requestId: null });
  const reply = await createDbSystemQueryService({} as Sql, "web").reply(scope, { question: "模型设置", parentBudget: { id: "study-ephemeral:test" } });
  expect(reply.receipt.mode).toBe("native_tools"); expect(reply.receipt.reason).toBe("read");
  expect(reply.text).toContain("已保存的设置"); expect(reply.text).not.toContain("不得展示的模型结论");
  expect(fixture.call.mock.calls.map(call => call[2].parentBudget.id)).toEqual(["study-ephemeral:test", "study-ephemeral:test"]);
  expect(fixture.call.mock.calls.map(call => call[2].operationId)).toEqual(["system-query:study-ephemeral:test:round:0", "system-query:study-ephemeral:test:round:1"]);
});
it("a failed native query retains actual deterministic reads and an honest fallback receipt", async () => {
  fixture.call.mockRejectedValue(new Error("model unavailable"));
  const reply = await createDbSystemQueryService({} as Sql, "worker").reply(scope, { question: "模型设置", parentBudget: { id: "study-turn:test" } });
  expect(reply.receipt).toMatchObject({ mode: "deterministic", reason: "model_unavailable" });
  expect(fixture.read).toHaveBeenCalledTimes(1); expect(reply.text).toContain("固定规则查询");
});
it("cancelling the claimed job after round one prevents later tools, paid rounds and reply publication", async () => {
  let currentLease = true;
  const sql = vi.fn(async () => currentLease ? [{ id }] : []) as unknown as Sql;
  fixture.call.mockImplementationOnce(async (_scope, _task, options) => {
    await options.beforeSend(); currentLease = false;
    return { text: "ignored", citedChunkIds: [], candidates: [], inputTokens: 1, outputTokens: 1, requestId: null,
      toolCalls: [{ id: "read1", name: "settings", arguments: "{}" }] };
  });
  await expect(createDbSystemQueryService(sql, "worker").reply(scope, { question: "模型设置", parentBudget: { id: "study-turn:test" }, jobLease: { jobId: id, claimToken: id } })).rejects.toThrow("context changed");
  expect(fixture.call).toHaveBeenCalledTimes(1); expect(fixture.read).not.toHaveBeenCalled();
});
it("bounds a hanging prior referent resolver before entering planning", async () => {
  vi.useFakeTimers();
  try {
    const pending = createDbSystemQueryService({} as Sql, "web").reply(scope, { question: "那明天呢", resolvePreviousQuestion: () => new Promise(() => {}) });
    const assertion = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(12001); await assertion;
    expect(fixture.call).not.toHaveBeenCalled(); expect(fixture.read).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});
it("passes authenticated history as separate questions through the shared runtime", async () => {
  fixture.grant.mockResolvedValue({ authorization, privacyEpoch: 0, localDate: "2026-10-19" });
  fixture.read.mockImplementation(async (request: SystemQueryRequest) => ({ name: request.name, authorization, status: "ok", reason: "read", asOf: new Date().toISOString(),
    version: "v1", data: request.name === "courses"
      ? [{ id, title: "高等数学", updatedAt: new Date().toISOString(), goal: null, goalStatus: "not_configured", summary: "高等数学" }]
      : [{ date: "2026-10-19", timeZone: "UTC", acceptedVersion: 1, summary: "已确认的课程计划" }], evidence: [], sourceRefs: [], nextOffset: null }));
  const resolvePreviousQuestion = vi.fn(async () => previousRecordQuestion([{ role: "user", text: "《高等数学》的计划有哪些；当前任务有哪些" }]));
  const reply = await createDbSystemQueryService({} as Sql, "worker", { callModel: async () => { throw new Error("simulated model outage"); } })
    .reply(scope, { question: "刷新", resolvePreviousQuestion });
  expect(resolvePreviousQuestion).toHaveBeenCalledWith(0);
  expect(fixture.read.mock.calls.map(([request]) => request.name)).toEqual(["courses", "planning"]);
  expect(fixture.read).toHaveBeenLastCalledWith({ name: "planning", arguments: { courseId: id, date: "2026-10-19", limit: 5, offset: 0 } }, expect.any(AbortSignal));
  expect(reply.receipt.results.at(-1)?.reason).toBe("read");
});
