// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TurnRecord } from "@aistudy/contracts";
import type { OpeningApi } from "../client/api";
import { SLOW_TURN_MS, STALLED_TURN_MS, TURN_WAIT_COPY, failedTurnRetry, turnWaitPhase } from "./turn-wait";

vi.mock("../capabilities/capabilities-provider", async () => {
  const { CLOSED_CAPABILITIES } = await import("@aistudy/config/public");
  return { useOpeningCapabilities: () => CLOSED_CAPABILITIES };
});
vi.mock("../library/material-organization-client", () => ({ createMaterialOrganizationClient: () => ({ read: async () => ({ courses: [], memberships: [] }) }) }));
vi.mock("../teaching/learner-state-card", () => ({ LearnerStateCard: () => null }));
vi.mock("./ai-readiness", async () => {
  const { useEffect } = await import("react");
  return { AiReadinessChecklist: ({ onBlockedChange }: { onBlockedChange?: (value: boolean) => void }) => {
    useEffect(() => { onBlockedChange?.(false); }, [onBlockedChange]);
    return null;
  } };
});
vi.mock("./proposal-panel", () => ({ ProposalPanel: () => null }));

import { AssistantView, assistantContextScope } from "./assistant-view";
import { createQuestionDraftStore } from "./question-drafts";
import { publishVerifiedSessionIdentity } from "../../auth/session-identity";

const conversationId = "11111111-1111-4111-8111-111111111111";
const userTurnId = "22222222-2222-4222-8222-222222222222";
const assistantTurnId = "33333333-3333-4333-8333-333333333333";
const jobId = "44444444-4444-4444-8444-444444444444";
const nextJobId = "55555555-5555-4555-8555-555555555555";
const at = "2026-10-25T15:00:00.000Z";
const user: TurnRecord = { id: userTurnId, conversationId, role: "user", text: "为什么行列式等于零就不可逆？", citations: [], createdAt: at, mode: "hint", status: "complete" };
const assistant = (status: TurnRecord["status"]): TurnRecord => ({ id: assistantTurnId, conversationId, role: "assistant", text: status === "failed" ? "已停止这次回答。" : "", citations: [], createdAt: at, mode: "hint", status });

describe("turn wait phases", () => {
  it("stays quiet first, says it is slower after 20s and offers actions after 90s", () => {
    expect(turnWaitPhase(SLOW_TURN_MS - 1)).toBe("normal");
    expect(turnWaitPhase(SLOW_TURN_MS)).toBe("slow");
    expect(turnWaitPhase(STALLED_TURN_MS - 1)).toBe("slow");
    expect(turnWaitPhase(STALLED_TURN_MS)).toBe("stalled");
  });

  it("offers a retry only for the newest failed pair, with a key derived from the failed turn", () => {
    expect(failedTurnRetry([user, assistant("failed")])).toEqual({ assistantTurnId, text: user.text, mode: "hint", clientKey: `retry-${assistantTurnId}` });
    expect(failedTurnRetry([user, assistant("outcome_unknown")])).toBeNull();
    expect(failedTurnRetry([user, assistant("complete")])).toBeNull();
    expect(failedTurnRetry([user, assistant("pending")])).toBeNull();
    expect(failedTurnRetry([user, assistant("failed"), { ...user, id: nextJobId }])).toBeNull();
  });
});

let host: HTMLDivElement, root: Root;
let clearSessionIdentity: () => void;
let sessionIndex = 0;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear(); sessionStorage.clear();
  clearSessionIdentity = publishVerifiedSessionIdentity({ id: `${userTurnId}:${++sessionIndex}`, workspaceId: conversationId });
  vi.useFakeTimers();
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value() { this.setAttribute("open", ""); } },
    close: { configurable: true, value() { this.removeAttribute("open"); } },
  });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  clearSessionIdentity();
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const button = (label: string) => Array.from(host.querySelectorAll("button")).find(item => item.textContent === label);

function fakeApi(state: { turns: TurnRecord[]; pending: Awaited<ReturnType<OpeningApi["getPendingJob"]>> }, overrides: Partial<OpeningApi> = {}) {
  return {
    listSources: vi.fn(async () => []),
    resumeConversation: vi.fn(async () => ({ conversationId, courseId: null, sourceIds: [], boundedHistory: [], historyTruncated: false })),
    listTurns: vi.fn(async () => state.turns),
    getPendingJob: vi.fn(async () => state.pending),
    getJob: vi.fn(async () => state.pending ?? { id: jobId, status: "failed", error: null, updatedAt: at }),
    ...overrides,
  } as unknown as OpeningApi;
}

it("resends a failed turn with a stable retry key, so a second click cannot charge twice", async () => {
  const state = { turns: [user, { ...assistant("failed"), text: "服务暂时不可用" }], pending: null };
  const submitTurn = vi.fn<OpeningApi["submitTurn"]>(async () => ({ jobId: nextJobId, turnId: userTurnId, replayed: false }));
  const api = fakeApi(state, { submitTurn });
  await act(async () => root.render(<AssistantView api={api} initialConversationId={conversationId} />));
  await advance(0);
  expect(host.textContent).toContain("这次没有得到回答");
  expect(host.textContent).not.toContain("本轮失败");
  await act(async () => { button("重试")!.click(); button("重试")?.click(); });
  expect(submitTurn).toHaveBeenCalledOnce();
  expect(submitTurn.mock.calls[0]?.[0]).toMatchObject({ conversationId, text: user.text, mode: "hint", clientKey: `retry-${assistantTurnId}`, privacy: "saved" });
});

it("shows a slow state after 20s and 重试 / 取消 after 90s without text; 重试 stops the job before resending", async () => {
  const state: { turns: TurnRecord[]; pending: Awaited<ReturnType<OpeningApi["getPendingJob"]>> } = {
    turns: [user, assistant("pending")], pending: { id: jobId, status: "queued", error: null, updatedAt: at },
  };
  const submitTurn = vi.fn<OpeningApi["submitTurn"]>(async () => ({ jobId: nextJobId, turnId: userTurnId, replayed: false }));
  const cancelJob = vi.fn<OpeningApi["cancelJob"]>(async () => {
    state.turns = [user, assistant("failed")]; state.pending = null;
    return { id: jobId, status: "cancelled", error: null, updatedAt: at };
  });
  const api = fakeApi(state, { submitTurn, cancelJob });
  await act(async () => root.render(<AssistantView api={api} initialConversationId={conversationId} />));
  await advance(0);
  expect(host.textContent).toContain("正在思考");
  expect(host.textContent).not.toContain(TURN_WAIT_COPY.slow);
  await advance(SLOW_TURN_MS);
  expect(host.textContent).toContain(TURN_WAIT_COPY.slow);
  expect(button("重试")).toBeUndefined();
  await advance(STALLED_TURN_MS - SLOW_TURN_MS);
  expect(host.textContent).toContain(TURN_WAIT_COPY.stalled);
  expect(button("取消")).toBeDefined();
  expect(submitTurn).not.toHaveBeenCalled();
  await act(async () => { button("重试")!.click(); });
  await advance(0);
  expect(cancelJob).toHaveBeenCalledWith(jobId);
  expect(submitTurn).toHaveBeenCalledOnce();
  expect(cancelJob.mock.invocationCallOrder[0]).toBeLessThan(submitTurn.mock.invocationCallOrder[0]!);
  expect(submitTurn.mock.calls[0]?.[0]).toMatchObject({ text: user.text, clientKey: `retry-${assistantTurnId}` });
});

it("does not resend when stopping the stalled job ends with an unconfirmed outcome", async () => {
  const state: { turns: TurnRecord[]; pending: Awaited<ReturnType<OpeningApi["getPendingJob"]>> } = {
    turns: [user, assistant("pending")], pending: { id: jobId, status: "running", error: null, updatedAt: at },
  };
  const submitTurn = vi.fn<OpeningApi["submitTurn"]>();
  const cancelJob = vi.fn<OpeningApi["cancelJob"]>(async () => {
    state.turns = [user, assistant("outcome_unknown")]; state.pending = { id: jobId, status: "outcome_unknown", error: null, updatedAt: at };
    return state.pending;
  });
  const api = fakeApi(state, { submitTurn, cancelJob });
  await act(async () => root.render(<AssistantView api={api} initialConversationId={conversationId} />));
  await advance(STALLED_TURN_MS);
  await act(async () => { button("重试")!.click(); });
  await advance(0);
  expect(cancelJob).toHaveBeenCalledOnce();
  expect(submitTurn).not.toHaveBeenCalled();
});

it("starts only one cancellation when stalled retry is clicked twice before the stop returns", async () => {
  const state: { turns: TurnRecord[]; pending: Awaited<ReturnType<OpeningApi["getPendingJob"]>> } = {
    turns: [user, assistant("pending")], pending: { id: jobId, status: "running", error: null, updatedAt: at },
  };
  let resolveStop!: (job: Awaited<ReturnType<OpeningApi["cancelJob"]>>) => void;
  const cancelJob = vi.fn<OpeningApi["cancelJob"]>(() => new Promise(resolve => { resolveStop = resolve; }));
  const submitTurn = vi.fn<OpeningApi["submitTurn"]>(async () => ({ jobId: nextJobId, turnId: userTurnId, replayed: false }));
  await act(async () => root.render(<AssistantView api={fakeApi(state, { cancelJob, submitTurn })} initialConversationId={conversationId} />));
  await advance(STALLED_TURN_MS);
  await act(async () => { button("重试")!.click(); button("重试")!.click(); });
  expect(cancelJob).toHaveBeenCalledOnce();
  await act(async () => {
    state.turns = [user, assistant("failed")]; state.pending = null;
    resolveStop({ id: jobId, status: "cancelled", error: null, updatedAt: at });
  });
  await advance(0);
  expect(submitTurn).toHaveBeenCalledOnce();
  expect(submitTurn.mock.calls[0]?.[0].clientKey).toBe(`retry-${assistantTurnId}`);
});
const idleMs = 10 * 60 * 1000;
function resumableApi(status: TurnRecord["status"], updatedAt = at) {
  const state: { turns: TurnRecord[]; pending: Awaited<ReturnType<OpeningApi["getPendingJob"]>> } = {
    turns: [user, assistant(status)], pending: status === "pending" || status === "outcome_unknown"
      ? { id: jobId, status: status === "pending" ? "running" : "outcome_unknown", error: null, updatedAt } : null,
  };
  return { state, api: fakeApi(state, { listConversations: vi.fn(async () => [{ id: conversationId, title: "历史对话", courseId: null, updatedAt, lastTurnPreview: "旧问题" }]) }) };
}

it("starts a fresh implicit drawer session for a failed last turn older than ten minutes without deleting history", async () => {
  vi.setSystemTime(new Date(Date.parse(at) + idleMs + 1));
  const { api } = resumableApi("failed");
  await act(async () => root.render(<AssistantView api={api} embedded implicitResumeVersion={1} />));
  await advance(0);
  expect(host.textContent).not.toContain(user.text);
  expect(host.textContent).toContain("想弄懂什么");
  expect(api.listTurns).toHaveBeenCalledWith(conversationId, expect.any(AbortSignal));
  expect(api.createConversation).toBeUndefined();
});

it.each(["failed", "pending", "outcome_unknown"] as const)("keeps explicitly selected %s history even when old", async status => {
  vi.setSystemTime(new Date(Date.parse(at) + idleMs + 1));
  const { api } = resumableApi(status);
  await act(async () => root.render(<AssistantView api={api} embedded initialConversationId={conversationId} implicitResumeVersion={1} />));
  await advance(0);
  expect(host.textContent).toContain(user.text);
});

it.each(["pending", "outcome_unknown"] as const)("keeps an old implicitly resumed %s turn", async status => {
  vi.setSystemTime(new Date(Date.parse(at) + idleMs + 1));
  const { api } = resumableApi(status);
  await act(async () => root.render(<AssistantView api={api} embedded implicitResumeVersion={1} />));
  await advance(0);
  expect(host.textContent).toContain(user.text);
});

it("checks a mounted drawer again when reopened after ten minutes", async () => {
  vi.setSystemTime(new Date(Date.parse(at) + idleMs));
  const { api } = resumableApi("failed");
  await act(async () => root.render(<AssistantView api={api} embedded implicitResumeVersion={1} />));
  await advance(0);
  expect(host.textContent).toContain(user.text);
  vi.setSystemTime(new Date(Date.parse(at) + idleMs + 1));
  await act(async () => root.render(<AssistantView api={api} embedded implicitResumeVersion={2} />));
  await advance(0);
  expect(host.textContent).not.toContain(user.text);
});

it("retains unsent input when an old failed drawer session reopens", async () => {
  vi.setSystemTime(new Date(at));
  const { api } = resumableApi("failed");
  await act(async () => root.render(<AssistantView api={api} embedded initialDraft="下一问草稿" implicitResumeVersion={1} />));
  await advance(0);
  vi.setSystemTime(new Date(Date.parse(at) + idleMs + 1));
  await act(async () => root.render(<AssistantView api={api} embedded initialDraft="下一问草稿" implicitResumeVersion={2} />));
  await advance(0);
  expect(host.textContent).toContain(user.text);
  expect(host.querySelector("textarea")?.value).toBe("下一问草稿");
});

it("waits ten more minutes after observing a long-running request stop", async () => {
  vi.setSystemTime(new Date(Date.parse(at) + idleMs + 1));
  const { api, state } = resumableApi("pending");
  await act(async () => root.render(<AssistantView api={api} embedded implicitResumeVersion={1} />));
  await advance(0);
  state.turns = [user, assistant("failed")]; state.pending = null;
  await advance(1000);
  await act(async () => root.render(<AssistantView api={api} embedded implicitResumeVersion={2} />));
  await advance(0);
  expect(host.textContent).toContain(user.text);
  vi.setSystemTime(new Date(Date.now() + idleMs + 1));
  await act(async () => root.render(<AssistantView api={api} embedded implicitResumeVersion={3} />));
  await advance(0);
  expect(host.textContent).not.toContain(user.text);
});
it("restores the saved conversation draft before deciding whether an old failure can be skipped", async () => {
  const clearIdentity = publishVerifiedSessionIdentity({ id: userTurnId, workspaceId: conversationId });
  const store = createQuestionDraftStore();
  const scope = `${assistantContextScope(undefined)}::${conversationId}:::`;
  store.write(scope, "已保存但未发送的问题");
  vi.setSystemTime(new Date(Date.parse(at) + idleMs + 1));
  const { api } = resumableApi("failed");
  try {
    await act(async () => root.render(<AssistantView api={api} embedded implicitResumeVersion={1} />));
    await advance(0);
    expect(host.textContent).toContain(user.text);
    expect(host.querySelector("textarea")?.value).toBe("已保存但未发送的问题");
    expect(store.read(scope)).toBe("已保存但未发送的问题");
  } finally { store.remove(scope); clearIdentity(); }
});

it("retains an unsubmitted upload and its failed conversation on reopening", async () => {
  vi.setSystemTime(new Date(at));
  const { api } = resumableApi("failed");
  await act(async () => root.render(<AssistantView api={api} embedded implicitResumeVersion={1} />));
  await advance(0);
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="选择参考材料"]')!.click());
  const picker = host.querySelector<HTMLInputElement>("input[multiple]")!;
  const file = new File(["photo"], "尚未上传的题目.jpg", { type: "image/jpeg" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => { throw new Error("读取中断"); } });
  Object.defineProperty(picker, "files", { value: [file], configurable: true });
  await act(async () => picker.dispatchEvent(new Event("change", { bubbles: true })));
  expect(host.textContent).toContain(file.name);
  vi.setSystemTime(new Date(Date.parse(at) + idleMs + 1));
  await act(async () => root.render(<AssistantView api={api} embedded implicitResumeVersion={2} />));
  await advance(0);
  expect(host.textContent).toContain(user.text);
  expect(host.textContent).toContain(file.name);
  expect(host.querySelector('[aria-label="助手上传队列"]')?.textContent).toContain(file.name);
});

it("does not turn a failed pending-job discovery into permission to skip old history", async () => {
  vi.setSystemTime(new Date(Date.parse(at) + idleMs + 1));
  const { api } = resumableApi("failed");
  api.getPendingJob = vi.fn(async () => { throw new Error("读取中断"); });
  await act(async () => root.render(<AssistantView api={api} embedded implicitResumeVersion={1} />));
  await advance(0);
  expect(host.textContent).toContain(user.text);
  expect(host.textContent).toContain("尚未确认是否有进行中的回答");
});
it("retains old failed history when the saved draft cannot be read", async () => {
  vi.setSystemTime(new Date(Date.parse(at) + idleMs + 1));
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("存储不可用"); });
  const { api } = resumableApi("failed");
  await act(async () => root.render(<AssistantView api={api} embedded implicitResumeVersion={1} />));
  await advance(0);
  expect(host.textContent).toContain(user.text);
  expect(host.textContent).toContain("浏览器暂时无法保存");
});

it("keeps a local retry attached while submit is in flight and history has not caught up", async () => {
  vi.setSystemTime(new Date(at));
  const { api, state } = resumableApi("failed");
  let finishSubmit!: (result: Awaited<ReturnType<OpeningApi["submitTurn"]>>) => void;
  const submitTurn = vi.fn<OpeningApi["submitTurn"]>(() => new Promise(resolve => { finishSubmit = resolve; }));
  api.submitTurn = submitTurn;
  const changed = vi.fn();
  await act(async () => root.render(<AssistantView api={api} embedded implicitResumeVersion={1} onConversationChange={changed} />));
  await advance(0);
  await act(async () => button("重新回答")!.click());
  vi.setSystemTime(new Date(Date.parse(at) + idleMs + 1));
  await act(async () => root.render(<AssistantView api={api} embedded implicitResumeVersion={2} onConversationChange={changed} />));
  await advance(0);
  expect(host.textContent).toContain(user.text);
  expect(changed).not.toHaveBeenCalledWith(null);
  await act(async () => {
    state.turns = [user, assistant("pending")];
    state.pending = { id: nextJobId, status: "running", error: null, updatedAt: at };
    finishSubmit({ jobId: nextJobId, turnId: userTurnId, replayed: false });
  });
  await advance(0);
  expect(api.getJob).toHaveBeenCalledWith(nextJobId, expect.any(AbortSignal));
  expect(submitTurn).toHaveBeenCalledOnce();
});
it("shares the stop lock between cancellation and stalled retry", async () => {
  const state: { turns: TurnRecord[]; pending: Awaited<ReturnType<OpeningApi["getPendingJob"]>> } = {
    turns: [user, assistant("pending")], pending: { id: jobId, status: "running", error: null, updatedAt: at },
  };
  let resolveStop!: (job: Awaited<ReturnType<OpeningApi["cancelJob"]>>) => void;
  const cancelJob = vi.fn<OpeningApi["cancelJob"]>(() => new Promise(resolve => { resolveStop = resolve; }));
  const submitTurn = vi.fn<OpeningApi["submitTurn"]>();
  await act(async () => root.render(<AssistantView api={fakeApi(state, { cancelJob, submitTurn })} initialConversationId={conversationId} />));
  await advance(STALLED_TURN_MS);
  await act(async () => { button("取消")!.click(); button("取消")!.click(); button("重试")!.click(); });
  expect(cancelJob).toHaveBeenCalledOnce();
  await act(async () => {
    state.turns = [user, assistant("failed")]; state.pending = null;
    resolveStop({ id: jobId, status: "cancelled", error: null, updatedAt: at });
  });
  await advance(0);
  expect(submitTurn).not.toHaveBeenCalled();
  expect(host.textContent).toContain("已停止。");
});

it("preserves a local unknown outcome when a reopen sees an older failed snapshot", async () => {
  vi.setSystemTime(new Date(at));
  const { api, state } = resumableApi("outcome_unknown");
  const changed = vi.fn();
  await act(async () => root.render(<AssistantView api={api} embedded implicitResumeVersion={1} onConversationChange={changed} />));
  await advance(0);
  state.turns = [user, assistant("failed")]; state.pending = null;
  vi.setSystemTime(new Date(Date.parse(at) + idleMs + 1));
  await act(async () => root.render(<AssistantView api={api} embedded implicitResumeVersion={2} onConversationChange={changed} />));
  await advance(0);
  expect(host.textContent).toContain(user.text);
  expect(changed).not.toHaveBeenCalledWith(null);
  expect(button("重新回答")).toBeUndefined();
});
it("keeps a newer failed message when the earlier summary read has an old activity time", async () => {
  const now = Date.parse(at) + idleMs + 1;
  vi.setSystemTime(new Date(now));
  const { api, state } = resumableApi("failed");
  state.turns = [user, { ...assistant("failed"), createdAt: new Date(now).toISOString() }];
  await act(async () => root.render(<AssistantView api={api} embedded implicitResumeVersion={1} />));
  await advance(0);
  expect(host.textContent).toContain(user.text);
});
it("preserves persisted drafts in both scopes when migration cannot read storage but deletion still works", async () => {
  const owner = "unread-draft-owner";
  const clearIdentity = publishVerifiedSessionIdentity({ id: owner, workspaceId: conversationId });
  const prefix = `opening:question-draft:v2:${encodeURIComponent(JSON.stringify([owner, conversationId]))}:`;
  const previousScope = `${assistantContextScope(undefined)}:::::`;
  const targetScope = `${assistantContextScope(undefined)}::${conversationId}:::`;
  const previousKey = prefix + previousScope, targetKey = prefix + targetScope;
  const previousRaw = JSON.stringify({ version: 1, text: "开始页尚未发送的问题" });
  const targetRaw = JSON.stringify({ version: 1, text: "历史会话尚未发送的问题" });
  sessionStorage.setItem(previousKey, previousRaw);
  sessionStorage.setItem(targetKey, targetRaw);
  const getItem = Storage.prototype.getItem;
  const readFailure = vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, key) {
    if (key === previousKey || key === targetKey) throw new Error("只能写入，暂时不能读取");
    return getItem.call(this, key);
  });
  vi.setSystemTime(new Date(Date.parse(at) + idleMs + 1));
  const { api } = resumableApi("failed");
  try {
    await act(async () => root.render(<AssistantView api={api} embedded implicitResumeVersion={1} />));
    await advance(0);
    expect(host.textContent).toContain(user.text);
    expect(getItem.call(sessionStorage, targetKey)).toBe(targetRaw);
    expect(getItem.call(sessionStorage, previousKey)).toBe(previousRaw);
    readFailure.mockRestore();
    const store = createQuestionDraftStore();
    expect(store.read(targetScope)).toBe("历史会话尚未发送的问题");
    expect(store.read(previousScope)).toBe("开始页尚未发送的问题");
  } finally { readFailure.mockRestore(); clearIdentity(); }
});
