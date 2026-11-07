// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createKnowledgeRebuildClient } from "./knowledge-rebuild-client";
import { KNOWLEDGE_POLL_INTERVAL_MS, KNOWLEDGE_POLL_TIMEOUT_MS, KnowledgeRebuildControl } from "./knowledge-rebuild-control";

const courseId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", jobId = "11111111-1111-4111-8111-111111111111";
type Server = { version: number; nodes: number; created: boolean; posts: unknown[]; reads: number; signals: AbortSignal[]; post?: () => Response | Promise<Response>; read?: (read: number) => Promise<Response> | undefined };
let host: HTMLDivElement, root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

function server(patch: Partial<Server> = {}): Server { return { version: 2, nodes: 0, created: true, posts: [], reads: 0, signals: [], ...patch }; }
// The fake transport ignores aborts on purpose, so a held request can still answer late.
function held() { let release!: (response: Response) => void; const response = new Promise<Response>(resolve => { release = resolve; }); return { response, release }; }
const receipt = () => Response.json({ jobId, kind: "build-course-knowledge", created: true });
function record(state: Server) {
  const nodes = Array.from({ length: state.nodes }, (_, index) => ({ id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, courseId, label: `知识点${index}`, kind: "concept", evidenceChunkIds: [], status: "suggested" }));
  return { version: state.version, snapshot: { courseId, version: state.version, nodes, edges: [] }, sourceVersions: {} };
}
function transport(state: Server) {
  return vi.fn<typeof fetch>(async (_input, init) => {
    if (init?.signal) state.signals.push(init.signal);
    if (init?.method !== "POST") { state.reads += 1; return (await state.read?.(state.reads)) ?? Response.json(record(state)); }
    state.posts.push(JSON.parse(String(init.body)));
    return state.post ? state.post() : Response.json({ jobId, kind: "build-course-knowledge", created: state.created });
  });
}
async function render(state: Server, onRebuilt = vi.fn()) {
  await act(async () => root.render(<KnowledgeRebuildControl courseId={courseId} client={createKnowledgeRebuildClient(transport(state))} onRebuilt={onRebuilt} />));
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
