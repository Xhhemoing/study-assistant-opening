// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CourseKnowledgeSync } from "@aistudy/contracts";
import { createKnowledgeRebuildClient } from "./knowledge-rebuild-client";
import { KNOWLEDGE_POLL_INTERVAL_MS, KNOWLEDGE_POLL_TIMEOUT_MS, KnowledgeRebuildControl } from "./knowledge-rebuild-control";

const courseId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", jobId = "11111111-1111-4111-8111-111111111111";
type Server = { version: number; nodes: number; created: boolean; sync?: CourseKnowledgeSync; posts: unknown[]; reads: number; signals: AbortSignal[]; post?: () => Response | Promise<Response>; read?: (read: number) => Promise<Response> | undefined };
let host: HTMLDivElement, root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function server(patch: Partial<Server> = {}): Server { return { version: 2, nodes: 0, created: true, posts: [], reads: 0, signals: [], ...patch }; }
// The fake transport ignores aborts on purpose, so a held request can still answer late.
function held() { let release!: (response: Response) => void; const response = new Promise<Response>(resolve => { release = resolve; }); return { response, release }; }
const receipt = () => Response.json({ jobId, kind: "build-course-knowledge", created: true });
function record(state: Server) {
  const nodes = Array.from({ length: state.nodes }, (_, index) => ({ id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, courseId, label: `知识点${index}`, kind: "concept", evidenceChunkIds: [], status: "suggested" }));
  return { version: state.version, snapshot: { courseId, version: state.version, nodes, edges: [] }, sourceVersions: {}, ...(state.sync ? { sync: state.sync } : {}) };
}
function transport(state: Server) {
  return vi.fn<typeof fetch>(async (_input, init) => {
    if (init?.signal) state.signals.push(init.signal);
    if (init?.method !== "POST") { state.reads += 1; return (await state.read?.(state.reads)) ?? Response.json(record(state)); }
    state.posts.push(JSON.parse(String(init.body)));
    return state.post ? state.post() : Response.json({ jobId, kind: "build-course-knowledge", created: state.created });
  });
}
async function render(state: Server, onRebuilt = vi.fn(), onSyncUpdated = vi.fn()) {
  await act(async () => root.render(
    <KnowledgeRebuildControl
      courseId={courseId}
      client={createKnowledgeRebuildClient(transport(state))}
      onRebuilt={onRebuilt}
      onSyncUpdated={onSyncUpdated}
    />,
  ));
  return onRebuilt;
}
function action() { const node = host.querySelector("button"); if (!node) throw new Error("missing rebuild button"); return node; }
function status() { return host.querySelector('[role="status"]')?.textContent ?? ""; }
async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }

it("sends one rebuild with only a fresh client key and stays disabled until a newer knowledge version appears", async () => {
  let releasePost!: () => void;
  const state = server({ post: () => new Promise<Response>(resolve => { releasePost = () => resolve(Response.json({ jobId, kind: "build-course-knowledge", created: true })); }) });
  const onRebuilt = await render(state);
  await act(async () => { action().click(); action().click(); });
  expect(state.posts).toEqual([{ clientKey: expect.stringMatching(/^knowledge-rebuild:[0-9a-f-]{36}$/) }]);
  expect(action().disabled).toBe(true);
  expect(action().textContent).toBe("整理中…");
  expect(status()).toContain("整理中");
  await act(async () => { releasePost(); });
  await advance(KNOWLEDGE_POLL_INTERVAL_MS);
  expect(action().disabled).toBe(true);
  expect(onRebuilt).not.toHaveBeenCalled();
  state.version = 3; state.nodes = 2;
  await advance(KNOWLEDGE_POLL_INTERVAL_MS);
  expect(status()).toBe("已整理：共 2 个知识点。刷新页面可查看新的知识图。");
  expect(onRebuilt).toHaveBeenCalledTimes(1);
  expect(onRebuilt.mock.calls[0]?.[0]).toMatchObject({ version: 3 });
  expect(action().disabled).toBe(false);
  const reads = state.reads;
  await advance(KNOWLEDGE_POLL_INTERVAL_MS * 5);
  expect(state.reads).toBe(reads);
  expect(state.posts).toHaveLength(1);
});

it("keeps polling an existing job and times out with the agreed copy instead of claiming failure", async () => {
  const state = server({ created: false });
  const onRebuilt = await render(state);
  await act(async () => action().click());
  expect(state.posts).toHaveLength(1);
  await advance(KNOWLEDGE_POLL_INTERVAL_MS);
  expect(state.reads).toBe(2);
  expect(action().disabled).toBe(true);
  await advance(KNOWLEDGE_POLL_TIMEOUT_MS);
  expect(status()).toBe("没有看到新的整理结果，可以稍后刷新再看。");
  expect(host.textContent).not.toContain("失败");
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(onRebuilt).not.toHaveBeenCalled();
  expect(action().disabled).toBe(false);
  const reads = state.reads;
  await advance(KNOWLEDGE_POLL_INTERVAL_MS * 5);
  expect(state.reads).toBe(reads);
});

it("never sends the rebuild when unmounted while the baseline read is still pending", async () => {
  const baseline = held();
  const state = server({ read: read => read === 1 ? baseline.response : undefined });
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const onRebuilt = await render(state);
  await act(async () => action().click());
  await act(async () => root.unmount());
  expect(state.signals[0]?.aborted).toBe(true);
  await act(async () => { baseline.release(Response.json(record(state))); });
  await advance(KNOWLEDGE_POLL_TIMEOUT_MS);
  expect(state.posts).toHaveLength(0);
  expect(state.reads).toBe(1);
  expect(onRebuilt).not.toHaveBeenCalled();
  expect(errors).not.toHaveBeenCalled();
  root = createRoot(host);
});

it("aborts a pending rebuild request on unmount and never starts polling", async () => {
  const post = held();
  const state = server({ post: () => post.response });
  await render(state);
  await act(async () => action().click());
  expect(state.posts).toHaveLength(1);
  await act(async () => root.unmount());
  expect(state.signals[1]?.aborted).toBe(true);
  await act(async () => { post.release(receipt()); });
  await advance(KNOWLEDGE_POLL_INTERVAL_MS * 3);
  expect(state.reads).toBe(1);
  root = createRoot(host);
});

it.each([
  ["the baseline read", (gate: ReturnType<typeof held>) => server({ read: read => read === 1 ? gate.response : undefined }), 1, 0, (state: Server) => Response.json(record(state))],
  ["the rebuild request", (gate: ReturnType<typeof held>) => server({ post: () => gate.response }), 1, 1, receipt],
  ["a polling read", (gate: ReturnType<typeof held>) => server({ read: read => read === 2 ? gate.response : undefined }), 2, 1, (state: Server) => Response.json(record(state))],
] as const)("times out three minutes after the click when %s never answers and ignores the late answer", async (_label, setup, reads, posts, late) => {
  const gate = held();
  const state = setup(gate);
  const onRebuilt = await render(state);
  await act(async () => action().click());
  await advance(KNOWLEDGE_POLL_TIMEOUT_MS - 1);
  expect(action().disabled).toBe(true);
  await advance(1);
  expect(status()).toBe("没有看到新的整理结果，可以稍后刷新再看。");
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(action().disabled).toBe(false);
  expect(state.signals.every(signal => signal.aborted)).toBe(true);
  expect([state.reads, state.posts.length]).toEqual([reads, posts]);
  state.version = 3; state.nodes = 2;
  await act(async () => { gate.release(late(state)); });
  await advance(KNOWLEDGE_POLL_INTERVAL_MS * 5);
  expect([state.reads, state.posts.length]).toEqual([reads, posts]);
  expect(status()).toBe("没有看到新的整理结果，可以稍后刷新再看。");
  expect(onRebuilt).not.toHaveBeenCalled();
});

it("starts a fresh operation right after a timeout and ignores the old operation's late polling answer", async () => {
  const gate = held();
  const state = server({ read: read => read === 2 ? gate.response : undefined });
  const onRebuilt = await render(state);
  await act(async () => action().click());
  await advance(KNOWLEDGE_POLL_TIMEOUT_MS);
  expect(status()).toBe("没有看到新的整理结果，可以稍后刷新再看。");
  expect(state.signals[2]?.aborted).toBe(true);
  await act(async () => action().click());
  expect([state.reads, state.posts.length]).toEqual([3, 2]);
  expect(action().disabled).toBe(true);
  await act(async () => { gate.release(Response.json(record({ ...state, version: 3, nodes: 2 }))); });
  expect(status()).toContain("整理中");
  expect(action().disabled).toBe(true);
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(onRebuilt).not.toHaveBeenCalled();
  expect([state.reads, state.posts.length]).toEqual([3, 2]);
  await advance(KNOWLEDGE_POLL_INTERVAL_MS);
  expect(state.reads).toBe(4);
  expect(status()).toContain("整理中");
  state.version = 4; state.nodes = 1;
  await advance(KNOWLEDGE_POLL_INTERVAL_MS);
  expect(status()).toBe("已整理：共 1 个知识点。刷新页面可查看新的知识图。");
  expect(onRebuilt).toHaveBeenCalledTimes(1);
  expect(onRebuilt.mock.calls[0]?.[0]).toMatchObject({ version: 4 });
  expect([state.reads, state.posts.length]).toEqual([5, 2]);
});

it.each([
  ["404 with the server's message", () => Response.json({ error: { code: "NOT_FOUND", message: "课程不存在或已无权访问" } }, { status: 404 }), "课程不存在或已无权访问"],
  ["403 without a message", () => new Response(null, { status: 403 }), "整理请求没有完成，请稍后重试。"],
] as const)("stops polling at once when a polling read returns %s", async (_label, failure, message) => {
  const state = server({ read: read => read === 2 ? Promise.resolve(failure()) : undefined });
  const onRebuilt = await render(state);
  await act(async () => action().click());
  await advance(KNOWLEDGE_POLL_INTERVAL_MS);
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(message);
  expect(action().disabled).toBe(false);
  expect(action().textContent).toBe("整理知识点");
  expect(state.signals.every(signal => signal.aborted)).toBe(true);
  await advance(KNOWLEDGE_POLL_TIMEOUT_MS);
  expect(state.reads).toBe(2);
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(message);
  expect(onRebuilt).not.toHaveBeenCalled();
});

it("keeps polling through a 500 read until a newer version appears", async () => {
  const state = server({ read: read => read === 2 ? Promise.resolve(Response.json({ error: { code: "INTERNAL", message: "服务暂时不可用" } }, { status: 500 })) : undefined });
  const onRebuilt = await render(state);
  await act(async () => action().click());
  await advance(KNOWLEDGE_POLL_INTERVAL_MS);
  expect(state.reads).toBe(2);
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(action().disabled).toBe(true);
  expect(state.signals.some(signal => signal.aborted)).toBe(false);
  state.version = 3; state.nodes = 2;
  await advance(KNOWLEDGE_POLL_INTERVAL_MS);
  expect(state.reads).toBe(3);
  expect(status()).toBe("已整理：共 2 个知识点。刷新页面可查看新的知识图。");
  expect(onRebuilt).toHaveBeenCalledTimes(1);
});

it("stops polling once unmounted", async () => {
  const polling = server();
  await render(polling);
  await act(async () => action().click());
  await advance(KNOWLEDGE_POLL_INTERVAL_MS);
  const reads = polling.reads;
  await act(async () => root.unmount());
  expect(polling.signals.every(signal => signal.aborted)).toBe(true);
  await advance(KNOWLEDGE_POLL_INTERVAL_MS * 3);
  expect(polling.reads).toBe(reads);
  root = createRoot(host);
});

it.each([
  ["the server's message", () => Response.json({ error: { code: "COURSE_ARCHIVED", message: "课程已归档，恢复后才能整理知识点" } }, { status: 409 }), "课程已归档，恢复后才能整理知识点"],
  ["a generic message", () => { throw new TypeError("Failed to fetch"); }, "整理请求没有完成，请稍后重试。"],
] as const)("shows %s when the rebuild request fails and restores the button", async (_label, post, message) => {
  const state = server({ post });
  await render(state);
  await act(async () => action().click());
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(message);
  expect(action().disabled).toBe(false);
  expect(action().textContent).toBe("整理知识点");
  await advance(KNOWLEDGE_POLL_TIMEOUT_MS);
  expect(state.reads).toBe(1);
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(message);
  await act(async () => action().click());
  expect(state.posts).toHaveLength(2);
});

it("does not complete falsely on confirmNode version bump while active job is still running, and distinguishes pending follow-up", async () => {
  const followUpJobId = "22222222-2222-4222-8222-222222222222";
  const state = server({
    version: 2,
    nodes: 1,
    sync: {
      status: "needs_rebuild",
      activeJobId: null,
      lastBuiltVersion: 2,
      coveredSourceVersions: { [courseId]: 1 },
      eligibleSourceVersions: { [courseId]: 2 },
      parsingSourceCount: 0,
    },
  });
  const onRebuilt = await render(state);
  await act(async () => action().click());
  // Simulate confirmNode bumping version (2 -> 3) while rebuild job is still active (lastBuiltVersion remains 2).
  state.version = 3;
  state.sync = {
    status: "pending",
    activeJobId: jobId,
    lastBuiltVersion: 2,
    coveredSourceVersions: { [courseId]: 1 },
    eligibleSourceVersions: { [courseId]: 2 },
    parsingSourceCount: 0,
  };
  await advance(KNOWLEDGE_POLL_INTERVAL_MS);
  expect(action().disabled).toBe(true);
  expect(onRebuilt).not.toHaveBeenCalled();

  // First job completes, but a follow-up coalesced job is now queued.
  state.version = 4;
  state.nodes = 3;
  state.sync = {
    status: "pending",
    activeJobId: followUpJobId,
    lastBuiltVersion: 4,
    coveredSourceVersions: { [courseId]: 2 },
    eligibleSourceVersions: { [courseId]: 2 },
    parsingSourceCount: 1,
  };
  await advance(KNOWLEDGE_POLL_INTERVAL_MS);
  expect(action().disabled).toBe(false);
  expect(status()).toBe("本批完成（共 3 个知识点），下一批正在整理；另有 1 份资料仍在解析中。");
  expect(onRebuilt).toHaveBeenCalledTimes(1);
});

it("completes immediately when an existing coalesced job already reached up_to_date", async () => {
  const state = server({
    version: 2,
    nodes: 2,
    created: false,
    sync: {
      status: "needs_rebuild",
      activeJobId: null,
      lastBuiltVersion: 2,
      coveredSourceVersions: { [courseId]: 1 },
      eligibleSourceVersions: { [courseId]: 2 },
      parsingSourceCount: 0,
    },
  });
  const onRebuilt = await render(state);
  await act(async () => action().click());
  state.sync = {
    status: "up_to_date",
    activeJobId: null,
    lastBuiltVersion: 2,
    coveredSourceVersions: { [courseId]: 2 },
    eligibleSourceVersions: { [courseId]: 2 },
    parsingSourceCount: 0,
  };
  await advance(KNOWLEDGE_POLL_INTERVAL_MS);
  expect(action().disabled).toBe(false);
  expect(status()).toBe("已整理：共 2 个知识点。刷新页面可查看新的知识图。");
  expect(onRebuilt).toHaveBeenCalledTimes(1);
});

it.each([
  ["failed", "本次整理未能完成，请稍后重试；若资料无法读取，请先在资料页检查。"],
  ["outcome_unknown", "本次整理结果暂未确认，以刷新后为准；请稍后刷新确认，无需立即重复提交。"],
  ["cancelled", "本次整理已取消；如需更新知识点，请重新点击整理。"],
] as const)("D2: stops polling on requestedJob=%s, notifies onSyncUpdated (never onRebuilt), and never auto-reposts even if another job J2 races ahead", async (terminalState, expectedAlert) => {
  const otherJobId = "22222222-2222-4222-8222-222222222222";
  const state = server({
    version: 2,
    nodes: 1,
    sync: {
      status: "needs_rebuild",
      activeJobId: null,
      lastBuiltVersion: 2,
      coveredSourceVersions: {},
      eligibleSourceVersions: { [courseId]: 1 },
      parsingSourceCount: 0,
      unreadableSourceCount: 0,
      rebuildBlockedByMaterials: false,
      lastFailedJob: null,
      requestedJob: null,
    },
  });
  const onSyncUpdated = vi.fn();
  const onRebuilt = await render(state, vi.fn(), onSyncUpdated);
  await act(async () => action().click());

  // J2 races ahead and bumps lastBuiltVersion AND fails another job, while J1 (requestedJob) is still running.
  state.version = 5;
  state.sync = {
    status: "pending",
    activeJobId: jobId,
    lastBuiltVersion: 5,
    coveredSourceVersions: { [courseId]: 1 },
    eligibleSourceVersions: { [courseId]: 1 },
    parsingSourceCount: 0,
    unreadableSourceCount: 0,
    rebuildBlockedByMaterials: false,
    lastFailedJob: { jobId: otherJobId, state: "failed" },
    requestedJob: { jobId, state: "running" },
  };
  await advance(KNOWLEDGE_POLL_INTERVAL_MS);
  expect(action().disabled).toBe(true);
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(onRebuilt).not.toHaveBeenCalled();
  expect(onSyncUpdated).not.toHaveBeenCalled();

  // Now J1 reaches terminal failure/unknown/cancelled state.
  state.sync = {
    ...state.sync,
    status: "needs_rebuild",
    activeJobId: null,
    lastFailedJob: terminalState === "cancelled" ? null : { jobId, state: terminalState },
    requestedJob: { jobId, state: terminalState },
  };
  await advance(KNOWLEDGE_POLL_INTERVAL_MS);
  expect(action().disabled).toBe(false);
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(expectedAlert);
  expect(onRebuilt).not.toHaveBeenCalled();
  expect(onSyncUpdated).toHaveBeenCalledTimes(1);
  expect(onSyncUpdated.mock.calls[0]?.[0]?.sync?.requestedJob).toEqual({ jobId, state: terminalState });
  expect(onSyncUpdated.mock.calls[0]?.[1]).toBe(terminalState);
  expect(state.posts).toHaveLength(1);
  const readsAfterStop = state.reads;
  await advance(KNOWLEDGE_POLL_INTERVAL_MS * 4);
  expect(state.reads).toBe(readsAfterStop);
  expect(state.posts).toHaveLength(1);
});

it("keeps independent failed-job alert and skips onRebuilt even when a subsequent succeeded job already cleared lastFailedJob", async () => {
  const state = server({
    version: 2,
    nodes: 1,
    sync: {
      status: "needs_rebuild",
      activeJobId: null,
      lastBuiltVersion: 2,
      coveredSourceVersions: {},
      eligibleSourceVersions: { [courseId]: 1 },
      parsingSourceCount: 0,
      unreadableSourceCount: 0,
      rebuildBlockedByMaterials: false,
      lastFailedJob: null,
      requestedJob: null,
    },
  });
  const onSyncUpdated = vi.fn();
  const onRebuilt = await render(state, vi.fn(), onSyncUpdated);
  await act(async () => action().click());

  state.version = 4;
  state.nodes = 3;
  state.sync = {
    status: "up_to_date",
    activeJobId: null,
    lastBuiltVersion: 4,
    coveredSourceVersions: { [courseId]: 1 },
    eligibleSourceVersions: { [courseId]: 1 },
    parsingSourceCount: 0,
    unreadableSourceCount: 0,
    rebuildBlockedByMaterials: false,
    lastFailedJob: null,
    requestedJob: { jobId, state: "failed" },
  };
  await advance(KNOWLEDGE_POLL_INTERVAL_MS);
  expect(action().disabled).toBe(false);
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("本次整理未能完成，请稍后重试；若资料无法读取，请先在资料页检查。");
  expect(onRebuilt).not.toHaveBeenCalled();
  expect(onSyncUpdated).toHaveBeenCalledTimes(1);
  expect(onSyncUpdated.mock.calls[0]?.[1]).toBe("failed");
});

it.each([
  [
    "pending follow-up",
    {
      status: "pending" as const,
      activeJobId: "22222222-2222-4222-8222-222222222222",
      lastBuiltVersion: 3,
      coveredSourceVersions: { [courseId]: 1 },
      eligibleSourceVersions: { [courseId]: 2 },
      parsingSourceCount: 0,
      unreadableSourceCount: 0,
      rebuildBlockedByMaterials: false,
      lastFailedJob: null,
      requestedJob: { jobId, state: "succeeded" as const },
    },
    2,
    "本批完成（共 2 个知识点），下一批正在整理。",
  ],
  [
    "needs_rebuild unblocked",
    {
      status: "needs_rebuild" as const,
      activeJobId: null,
      lastBuiltVersion: 3,
      coveredSourceVersions: { [courseId]: 1 },
      eligibleSourceVersions: { [courseId]: 2 },
      parsingSourceCount: 0,
      unreadableSourceCount: 0,
      rebuildBlockedByMaterials: false,
      lastFailedJob: null,
      requestedJob: { jobId, state: "succeeded" as const },
    },
    2,
    "本批完成，材料又有变化，请点击“重新整理知识点”同步最新内容。",
  ],
  [
    "needs_rebuild blocked by materials",
    {
      status: "needs_rebuild" as const,
      activeJobId: null,
      lastBuiltVersion: 3,
      coveredSourceVersions: { [courseId]: 1 },
      eligibleSourceVersions: {},
      parsingSourceCount: 0,
      unreadableSourceCount: 1,
      rebuildBlockedByMaterials: true,
      lastFailedJob: null,
      requestedJob: { jobId, state: "succeeded" as const },
    },
    2,
    "本批完成，材料又有变化；旧知识点已保留，请先前往资料页处理未就绪或无法读取的资料后再重新整理。",
  ],
  [
    "zero-node checked",
    {
      status: "up_to_date" as const,
      activeJobId: null,
      lastBuiltVersion: 3,
      coveredSourceVersions: { [courseId]: 1 },
      eligibleSourceVersions: { [courseId]: 1 },
      parsingSourceCount: 0,
      unreadableSourceCount: 0,
      rebuildBlockedByMaterials: false,
      lastFailedJob: null,
      requestedJob: { jobId, state: "succeeded" as const },
    },
    0,
    "已检查可读资料，未提取到知识点。",
  ],
  [
    "partial materials (unreadable remainder)",
    {
      status: "up_to_date" as const,
      activeJobId: null,
      lastBuiltVersion: 3,
      coveredSourceVersions: { [courseId]: 1 },
      eligibleSourceVersions: { [courseId]: 1 },
      parsingSourceCount: 0,
      unreadableSourceCount: 1,
      rebuildBlockedByMaterials: false,
      lastFailedJob: null,
      requestedJob: { jobId, state: "succeeded" as const },
    },
    2,
    "已整理当前可读资料（共 2 个知识点），但有 1 份资料无法读取文字，尚未覆盖全部资料；请前往资料页处理后再整理。",
  ],
])("D5: reports accurate completion copy for %s and notifies onRebuilt exactly once", async (_label, nextSync, nodes, expectedStatus) => {
  const state = server({
    version: 2,
    nodes: 1,
    sync: {
      status: "needs_rebuild",
      activeJobId: null,
      lastBuiltVersion: 2,
      coveredSourceVersions: {},
      eligibleSourceVersions: { [courseId]: 1 },
      parsingSourceCount: 0,
      unreadableSourceCount: 0,
      rebuildBlockedByMaterials: false,
      lastFailedJob: null,
      requestedJob: null,
    },
  });
  const onRebuilt = await render(state);
  await act(async () => action().click());
  state.version = 3;
  state.nodes = nodes;
  state.sync = nextSync;
  await advance(KNOWLEDGE_POLL_INTERVAL_MS);
  expect(action().disabled).toBe(false);
  expect(status()).toBe(expectedStatus);
  expect(onRebuilt).toHaveBeenCalledTimes(1);
  expect(state.posts).toHaveLength(1);
  const readsAfter = state.reads;
  await advance(KNOWLEDGE_POLL_INTERVAL_MS * 3);
  expect(state.reads).toBe(readsAfter);
});
