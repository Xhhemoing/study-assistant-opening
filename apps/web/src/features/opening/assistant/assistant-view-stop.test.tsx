// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { OpeningApi } from "../client/api";
import { AssistantView } from "./assistant-view";

vi.mock("../capabilities/capabilities-provider", async () => {
  const { CLOSED_CAPABILITIES } = await import("@aistudy/config/public");
  return { useOpeningCapabilities: () => CLOSED_CAPABILITIES };
});
vi.mock("../library/material-organization-client", () => ({ createMaterialOrganizationClient: () => ({ read: async () => ({ courses: [], memberships: [] }) }) }));
vi.mock("../teaching/learner-state-card", () => ({ LearnerStateCard: () => null }));
vi.mock("./proposal-panel", () => ({ ProposalPanel: () => null }));
vi.mock("./ai-readiness", async () => {
  const { useEffect } = await import("react");
  return { AiReadinessChecklist: ({ onBlockedChange }: { onBlockedChange: (blocked: boolean) => void }) => {
    useEffect(() => { onBlockedChange(false); }, [onBlockedChange]);
    return null;
  } };
});

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

it.each(["creating", "submitting"] as const)("honors Stop while %s a saved turn", async phase => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  const id = "11111111-1111-4111-8111-111111111111";
  const createConversation = vi.fn(async () => {
    if (phase === "creating") await delayed;
    return { id, title: "学习对话", courseId: null };
  });
  const submitTurn = vi.fn(async () => {
    if (phase === "submitting") await delayed;
    return { jobId: "job", turnId: "turn" };
  });
  const cancelJob = vi.fn(async () => ({ id: "job", status: "cancelled" }));
  const api = { listSources: async () => [], createConversation, submitTurn, cancelJob,
    resumeConversation: async () => ({ conversationId: id, courseId: null, sourceIds: [], boundedHistory: [] }),
    listTurns: async () => [], getPendingJob: async () => null, getJob: async () => ({ status: "cancelled" }),
  } as unknown as OpeningApi;
  try {
    await act(async () => root.render(<AssistantView api={api} startFresh initialDraft="请解释这道题" />));
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="发送"]')!.click());
    expect(createConversation).toHaveBeenCalledOnce();
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="停止回答"]')!.click());
    expect(host.querySelector('[aria-label="停止回答"]')).toBeNull();
    expect(host.textContent).toContain(phase === "creating" ? "提问尚未发送" : "正在等待确认后停止回答");
    await act(async () => release());
    if (phase === "creating") {
      expect(submitTurn).not.toHaveBeenCalled();
      expect(cancelJob).not.toHaveBeenCalled();
      expect(host.textContent).toContain("提问尚未发送");
      expect(host.querySelector("textarea")?.value).toBe("请解释这道题");
    } else {
      expect(submitTurn).toHaveBeenCalledOnce();
      expect(cancelJob.mock.calls).toEqual([["job"]]);
    }
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it("preserves pending Stop bound to clientKey across lost ack, delays, transient cancel drop, and never cancels another tab's job", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let rejectSubmit!: (reason?: unknown) => void;
  const submitPending = new Promise<never>((_resolve, reject) => { rejectSubmit = reject; });
  const id = "22222222-2222-4222-8222-222222222222";
  const jobId = "33333333-3333-4333-8333-333333333333";
  let submittedClientKey = "";
  let serverPhase: "committing" | "running" | "cancelled" = "committing";
  const createConversation = vi.fn(async () => ({ id, title: "学习对话", courseId: null }));
  const submitTurn = vi.fn((input: { clientKey: string }) => {
    submittedClientKey = input.clientKey;
    return submitPending;
  });
  const getJob = vi.fn(async () => ({ id: jobId, status: "running", error: null, updatedAt: new Date().toISOString() }));
  const cancelJob = vi.fn()
    .mockRejectedValueOnce(new TypeError("cancel network drop"))
    .mockImplementationOnce(async () => {
      serverPhase = "cancelled";
      return { id: jobId, status: "cancelled", error: null, updatedAt: new Date().toISOString() };
    });
  const getPendingJob = vi.fn(async (_conversationId: string, _signal?: AbortSignal, options?: { clientKey?: string }) => {
    if (serverPhase === "running") {
      return {
        id: jobId,
        status: "running" as const,
        error: null,
        updatedAt: new Date().toISOString(),
        ...(options?.clientKey ? { clientKey: submittedClientKey } : {}),
      };
    }
    if (serverPhase === "cancelled" && options?.clientKey) {
      return {
        id: jobId,
        status: "cancelled" as const,
        error: null,
        updatedAt: new Date().toISOString(),
        clientKey: submittedClientKey,
      };
    }
    return null;
  });
  const api = {
    listSources: async () => [],
    createConversation,
    submitTurn,
    cancelJob,
    resumeConversation: async () => ({ conversationId: id, courseId: null, sourceIds: [], boundedHistory: [] }),
    listTurns: async () => [],
    getPendingJob,
    getJob,
  } as unknown as OpeningApi;
  try {
    await act(async () => root.render(<AssistantView api={api} startFresh initialDraft="请解释这道题" />));
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="发送"]')!.click());
    expect(submitTurn).toHaveBeenCalledOnce();
    expect(submittedClientKey.length).toBeGreaterThan(0);
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="停止回答"]')!.click());
    expect(host.textContent).toContain("正在等待确认后停止回答");

    // Simulate network drop while the server is still committing the job.
    await act(async () => {
      rejectSubmit(new TypeError("lost ack"));
      await Promise.resolve();
    });
    expect(cancelJob).not.toHaveBeenCalled();
    expect(host.textContent).toContain("尚未确认发送结果，请重新读取对话");

    const reloadButton = () => Array.from(host.querySelectorAll("button")).find(b => b.textContent === "重新读取对话");
    const dismissButton = () => Array.from(host.querySelectorAll("button")).find(b => b.textContent === "继续提问");
    expect(reloadButton()).toBeTruthy();
    expect(dismissButton()).toBeTruthy();

    // First reread runs BEFORE the server finishes committing (pendingJob=null, turn not in history yet):
    // must RETAIN pendingStop and keep recovery active.
    await act(async () => reloadButton()!.click());
    expect(cancelJob).not.toHaveBeenCalled();
    expect(getJob).not.toHaveBeenCalled();
    expect(reloadButton()).toBeTruthy();

    // Server commits the job; second reread discovers our exact clientKey and attempts cancel (fails transiently).
    serverPhase = "running";
    await act(async () => reloadButton()!.click());
    expect(cancelJob.mock.calls).toEqual([[jobId]]);
    expect(getJob).not.toHaveBeenCalled();
    expect(reloadButton()).toBeTruthy();

    // Third reread retries cancel, succeeds, and settles without polling or streaming.
    await act(async () => reloadButton()!.click());
    expect(cancelJob.mock.calls).toEqual([[jobId], [jobId]]);
    expect(getJob).not.toHaveBeenCalled();
    expect(reloadButton()).toBeUndefined();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it("does not cancel an active job from another tab (different clientKey) and clears pendingStop on terminal turn or dismiss", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const id = "44444444-4444-4444-8444-444444444444";
  const otherJobId = "55555555-5555-4555-8555-555555555555";
  let rejectSubmit!: (reason?: unknown) => void;
  const submitPending = new Promise<never>((_resolve, reject) => { rejectSubmit = reject; });
  const createConversation = vi.fn(async () => ({ id, title: "学习对话", courseId: null }));
  const submitTurn = vi.fn(() => submitPending);
  const cancelJob = vi.fn(async () => ({ id: otherJobId, status: "cancelled", error: null, updatedAt: new Date().toISOString() }));
  const getJob = vi.fn(async () => ({ id: otherJobId, status: "running", error: null, updatedAt: new Date().toISOString() }));
  const getPendingJob = vi.fn(async () => ({
    id: otherJobId, status: "running" as const, error: null, updatedAt: new Date().toISOString(), clientKey: "other-tab-client-key",
  }));
  const api = {
    listSources: async () => [],
    createConversation,
    submitTurn,
    cancelJob,
    resumeConversation: async () => ({ conversationId: id, courseId: null, sourceIds: [], boundedHistory: [] }),
    listTurns: async () => [],
    getPendingJob,
    getJob,
  } as unknown as OpeningApi;
  try {
    await act(async () => root.render(<AssistantView api={api} startFresh initialDraft="原始提问" />));
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="发送"]')!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="停止回答"]')!.click());
    await act(async () => {
      rejectSubmit(new TypeError("lost ack"));
      await Promise.resolve();
    });

    const reloadButton = Array.from(host.querySelectorAll("button")).find(b => b.textContent === "重新读取对话")!;
    await act(async () => reloadButton.click());
    // Must NOT cancel the other tab's job, must NOT adopt its stream over our unresolved Stop, and must keep recovery armed.
    expect(cancelJob).not.toHaveBeenCalled();
    expect(getJob).not.toHaveBeenCalled();
    expect(Array.from(host.querySelectorAll("button")).find(b => b.textContent === "重新读取对话")).toBeTruthy();
    expect(Array.from(host.querySelectorAll("button")).find(b => b.textContent === "继续提问")).toBeTruthy();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it("clears pendingStop when scoped pending-job confirms our clientKey is terminal even with interleaved multi-tab turns", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const id = "66666666-6666-4666-8666-666666666666";
  const jobId = "67676767-6767-4767-8767-676767676767";
  const now = new Date().toISOString();
  let submittedClientKey = "";
  let rejectSubmit!: (reason?: unknown) => void;
  const submitPending = new Promise<never>((_resolve, reject) => { rejectSubmit = reject; });
  const createConversation = vi.fn(async () => ({ id, title: "学习对话", courseId: null }));
  const submitTurn = vi.fn((input: { clientKey: string }) => {
    submittedClientKey = input.clientKey;
    return submitPending;
  });
  const cancelJob = vi.fn();
  let jobPhase: "uncommitted" | "succeeded" = "uncommitted";
  const api = {
    listSources: async () => [],
    createConversation,
    submitTurn,
    cancelJob,
    resumeConversation: async () => ({ conversationId: id, courseId: null, sourceIds: [], boundedHistory: [] }),
    // Even if user turns appear interleaved before settlement, only scoped job terminal status clears pendingStop.
    listTurns: async () => (jobPhase === "succeeded" ? [
      { id: "77777777-7777-4777-8777-777777777777", conversationId: id, role: "user" as const, text: "原始提问", citations: [], createdAt: now, mode: "explain" as const, status: "complete" as const },
      { id: "88888888-8888-4888-8888-888888888888", conversationId: id, role: "assistant" as const, text: "已完成回答", citations: [], createdAt: now, mode: "explain" as const, status: "complete" as const },
    ] : [
      { id: "77777777-7777-4777-8777-777777777777", conversationId: id, role: "user" as const, text: "原始提问", citations: [], createdAt: now, mode: "explain" as const, status: "complete" as const },
      { id: "78787878-7878-4878-8878-787878787878", conversationId: id, role: "user" as const, text: "另一标签页提问", citations: [], createdAt: now, mode: "explain" as const, status: "complete" as const },
    ]),
    getPendingJob: vi.fn(async (_conversationId: string, _signal?: AbortSignal, options?: { clientKey?: string }) => (
      options?.clientKey && jobPhase === "succeeded"
        ? { id: jobId, status: "succeeded" as const, error: null, updatedAt: now, clientKey: submittedClientKey }
        : null
    )),
    getJob: async () => ({ id: jobId, status: "succeeded", error: null, updatedAt: now }),
  } as unknown as OpeningApi;
  try {
    await act(async () => root.render(<AssistantView api={api} startFresh initialDraft="原始提问" />));
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="发送"]')!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="停止回答"]')!.click());
    await act(async () => {
      rejectSubmit(new TypeError("lost ack"));
      await Promise.resolve();
    });

    const reloadButton = () => Array.from(host.querySelectorAll("button")).find(b => b.textContent === "重新读取对话");
    const dismissButton = () => Array.from(host.querySelectorAll("button")).find(b => b.textContent === "继续提问");
    // While scoped job is not confirmed terminal (even with interleaved user turns), recovery + dismiss stay available.
    await act(async () => reloadButton()!.click());
    expect(reloadButton()).toBeTruthy();
    expect(dismissButton()).toBeTruthy();

    // Once scoped pending-job confirms terminal status for our clientKey, pendingStop & recovery clear automatically.
    jobPhase = "succeeded";
    await act(async () => reloadButton()!.click());
    expect(cancelJob).not.toHaveBeenCalled();
    expect(reloadButton()).toBeUndefined();
    expect(dismissButton()).toBeUndefined();
    expect(host.textContent).toContain("已完成回答");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it("allows dismissing uncertain Stop recovery via 继续提问 when the POST never reached the server", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const id = "99999999-9999-4999-8999-999999999999";
  let rejectSubmit!: (reason?: unknown) => void;
  const submitPending = new Promise<never>((_resolve, reject) => { rejectSubmit = reject; });
  const api = {
    listSources: async () => [],
    createConversation: vi.fn(async () => ({ id, title: "学习对话", courseId: null })),
    submitTurn: vi.fn(() => submitPending),
    cancelJob: vi.fn(),
    resumeConversation: async () => ({ conversationId: id, courseId: null, sourceIds: [], boundedHistory: [] }),
    listTurns: async () => [],
    getPendingJob: async () => null,
    getJob: async () => ({ id: "job", status: "cancelled", error: null, updatedAt: new Date().toISOString() }),
  } as unknown as OpeningApi;
  try {
    await act(async () => root.render(<AssistantView api={api} startFresh initialDraft="离线提问" />));
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="发送"]')!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="停止回答"]')!.click());
    await act(async () => {
      rejectSubmit(new TypeError("offline before send"));
      await Promise.resolve();
    });
    const dismissButton = () => Array.from(host.querySelectorAll("button")).find(b => b.textContent === "继续提问");
    expect(dismissButton()).toBeTruthy();
    await act(async () => dismissButton()!.click());
    expect(dismissButton()).toBeUndefined();
    expect(host.querySelector<HTMLTextAreaElement>("textarea")?.disabled).toBe(false);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it("preserves deferred Stop recovery when submitRequest resolves after Stop and the first cancelJob fails", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const jobId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  let resolveSubmit!: (value: { jobId: string; turnId: string }) => void;
  const submitPending = new Promise<{ jobId: string; turnId: string }>(resolve => { resolveSubmit = resolve; });
  let submittedClientKey = "";
  let runningOnServer = true;
  const submitTurn = vi.fn((input: { clientKey: string }) => {
    submittedClientKey = input.clientKey;
    return submitPending;
  });
  const getJob = vi.fn(async () => ({ id: jobId, status: "running", error: null, updatedAt: new Date().toISOString() }));
  const cancelJob = vi.fn()
    .mockRejectedValueOnce(new TypeError("cancel network drop"))
    .mockImplementationOnce(async () => {
      runningOnServer = false;
      return { id: jobId, status: "cancelled", error: null, updatedAt: new Date().toISOString() };
    });
  const api = {
    listSources: async () => [],
    createConversation: vi.fn(async () => ({ id, title: "学习对话", courseId: null })),
    submitTurn,
    cancelJob,
    resumeConversation: async () => ({ conversationId: id, courseId: null, sourceIds: [], boundedHistory: [] }),
    listTurns: async () => [],
    getPendingJob: vi.fn(async () => (
      runningOnServer
        ? { id: jobId, status: "running" as const, error: null, updatedAt: new Date().toISOString(), clientKey: submittedClientKey }
        : null
    )),
    getJob,
  } as unknown as OpeningApi;
  try {
    await act(async () => root.render(<AssistantView api={api} startFresh initialDraft="请解释这道题" />));
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="发送"]')!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="停止回答"]')!.click());
    await act(async () => {
      resolveSubmit({ jobId, turnId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" });
      await Promise.resolve();
    });
    const reloadButton = () => Array.from(host.querySelectorAll("button")).find(b => b.textContent === "重新读取对话");
    expect(cancelJob.mock.calls).toEqual([[jobId]]);
    expect(getJob).not.toHaveBeenCalled();
    expect(reloadButton()).toBeTruthy();

    await act(async () => reloadButton()!.click());
    expect(cancelJob.mock.calls).toEqual([[jobId], [jobId]]);
    expect(getJob).not.toHaveBeenCalled();
    expect(reloadButton()).toBeUndefined();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it("preserves deferred Stop recovery when retryFailedTurn resolves after Stop and the first cancelJob fails", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const failedAssistantId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const retryJobId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const now = new Date().toISOString();
  let resolveRetry!: (value: { jobId: string; turnId: string }) => void;
  const retryPending = new Promise<{ jobId: string; turnId: string }>(resolve => { resolveRetry = resolve; });
  let retriedClientKey = "";
  let runningOnServer = false;
  const submitTurn = vi.fn((input: { clientKey: string }) => {
    retriedClientKey = input.clientKey;
    runningOnServer = true;
    return retryPending;
  });
  const getJob = vi.fn(async () => ({ id: retryJobId, status: "running", error: null, updatedAt: now }));
  const cancelJob = vi.fn()
    .mockRejectedValueOnce(new TypeError("retry cancel drop"))
    .mockImplementationOnce(async () => {
      runningOnServer = false;
      return { id: retryJobId, status: "cancelled", error: null, updatedAt: now };
    });
  const api = {
    listSources: async () => [],
    createConversation: vi.fn(),
    submitTurn,
    cancelJob,
    resumeConversation: async () => ({ conversationId: id, courseId: null, sourceIds: [], boundedHistory: [] }),
    listTurns: async () => [
      { id: "12121212-1212-4212-8212-121212121212", conversationId: id, role: "user" as const, text: "上次失败的提问", citations: [], createdAt: now, mode: "explain" as const, status: "complete" as const },
      { id: failedAssistantId, conversationId: id, role: "assistant" as const, text: "回答失败", citations: [], createdAt: now, mode: "explain" as const, status: "failed" as const },
    ],
    getPendingJob: vi.fn(async () => (
      runningOnServer
        ? { id: retryJobId, status: "running" as const, error: null, updatedAt: now, clientKey: retriedClientKey }
        : null
    )),
    getJob,
  } as unknown as OpeningApi;
  try {
    await act(async () => root.render(<AssistantView api={api} initialConversationId={id} />));
    const retryButton = Array.from(host.querySelectorAll("button")).find(b => b.textContent?.includes("重试"))!;
    expect(retryButton).toBeTruthy();
    await act(async () => retryButton.click());
    expect(submitTurn).toHaveBeenCalledOnce();
    expect(retriedClientKey).toBe(`retry-${failedAssistantId}`);
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="停止回答"]')!.click());
    await act(async () => {
      resolveRetry({ jobId: retryJobId, turnId: "34343434-3434-4434-8434-343434343434" });
      await Promise.resolve();
    });
    const reloadButton = () => Array.from(host.querySelectorAll("button")).find(b => b.textContent === "重新读取对话");
    expect(cancelJob.mock.calls).toEqual([[retryJobId]]);
    expect(getJob).not.toHaveBeenCalled();
    expect(reloadButton()).toBeTruthy();

    await act(async () => reloadButton()!.click());
    expect(cancelJob.mock.calls).toEqual([[retryJobId], [retryJobId]]);
    expect(getJob).not.toHaveBeenCalled();
    expect(reloadButton()).toBeUndefined();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it("recovers and cancels Tab A's active job by (conversationId, clientKey) even after Tab B queues a newer turn, without touching Tab B", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const id = "13131313-1313-4313-8313-131313131313";
  const tabAJobId = "14141414-1414-4414-8414-141414141414";
  const tabBJobId = "15151515-1515-4515-8515-151515151515";
  const now = new Date().toISOString();
  let tabAClientKey = "";
  let tabAActive = true;
  let rejectSubmit!: (reason?: unknown) => void;
  const submitPending = new Promise<never>((_resolve, reject) => { rejectSubmit = reject; });
  const submitTurn = vi.fn((input: { clientKey: string }) => {
    tabAClientKey = input.clientKey;
    return submitPending;
  });
  const cancelJob = vi.fn(async (jobId: string) => {
    if (jobId === tabAJobId) tabAActive = false;
    return { id: jobId, status: "cancelled" as const, error: null, updatedAt: now };
  });
  const getJob = vi.fn(async (jobId: string) => ({ id: jobId, status: "running" as const, error: null, updatedAt: now }));
  const getPendingJob = vi.fn(async (_conversationId: string, _signal?: AbortSignal, options?: { clientKey?: string }) => {
    if (options?.clientKey) {
      return options.clientKey === tabAClientKey && tabAActive
        ? { id: tabAJobId, status: "running" as const, error: null, updatedAt: now, clientKey: tabAClientKey }
        : null;
    }
    // Unfiltered lookup omits clientKey and returns only the newest job (Tab B), hiding Tab A's active job.
    return { id: tabBJobId, status: "running" as const, error: null, updatedAt: now };
  });
  const api = {
    listSources: async () => [],
    createConversation: vi.fn(async () => ({ id, title: "学习对话", courseId: null })),
    submitTurn,
    cancelJob,
    resumeConversation: async () => ({ conversationId: id, courseId: null, sourceIds: [], boundedHistory: [] }),
    listTurns: async () => [],
    getPendingJob,
    getJob,
  } as unknown as OpeningApi;
  try {
    await act(async () => root.render(<AssistantView api={api} startFresh initialDraft="Tab A 提问" />));
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="发送"]')!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="停止回答"]')!.click());
    await act(async () => {
      rejectSubmit(new TypeError("lost ack"));
      await Promise.resolve();
    });

    const reloadButton = Array.from(host.querySelectorAll("button")).find(b => b.textContent === "重新读取对话")!;
    expect(reloadButton).toBeTruthy();
    await act(async () => reloadButton.click());

    // Scoped lookup discovered and cancelled Tab A's job without touching Tab B, then adopted Tab B cleanly.
    expect(getPendingJob).toHaveBeenCalledWith(id, expect.anything(), { clientKey: tabAClientKey });
    expect(cancelJob.mock.calls).toEqual([[tabAJobId]]);
    expect(getJob).toHaveBeenCalledWith(tabBJobId, expect.anything());
    expect(Array.from(host.querySelectorAll("button")).find(b => b.textContent === "继续提问")).toBeUndefined();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it("keeps Tab A's Stop armed while Tab A's POST is uncommitted even when Tab B is active, then cancels Tab A once committed", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const id = "16161616-1616-4616-8616-161616161616";
  const tabAJobId = "18181818-1818-4818-8818-181818181818";
  const tabBJobId = "17171717-1717-4717-8717-171717171717";
  const now = new Date().toISOString();
  let tabAClientKey = "";
  let tabAPhase: "uncommitted" | "running" | "cancelled" = "uncommitted";
  let rejectSubmit!: (reason?: unknown) => void;
  const submitPending = new Promise<never>((_resolve, reject) => { rejectSubmit = reject; });
  const submitTurn = vi.fn((input: { clientKey: string }) => {
    tabAClientKey = input.clientKey;
    return submitPending;
  });
  const cancelJob = vi.fn(async (jobId: string) => {
    if (jobId === tabAJobId) tabAPhase = "cancelled";
    return { id: jobId, status: "cancelled" as const, error: null, updatedAt: now };
  });
  const getJob = vi.fn(async (jobId: string) => ({ id: jobId, status: "running" as const, error: null, updatedAt: now }));
  const getPendingJob = vi.fn(async (_conversationId: string, _signal?: AbortSignal, options?: { clientKey?: string }) => {
    if (options?.clientKey) {
      return options.clientKey === tabAClientKey && tabAPhase === "running"
        ? { id: tabAJobId, status: "running" as const, error: null, updatedAt: now, clientKey: tabAClientKey }
        : null;
    }
    return { id: tabBJobId, status: "running" as const, error: null, updatedAt: now };
  });
  const api = {
    listSources: async () => [],
    createConversation: vi.fn(async () => ({ id, title: "学习对话", courseId: null })),
    submitTurn,
    cancelJob,
    resumeConversation: async () => ({ conversationId: id, courseId: null, sourceIds: [], boundedHistory: [] }),
    listTurns: async () => [],
    getPendingJob,
    getJob,
  } as unknown as OpeningApi;
  try {
    await act(async () => root.render(<AssistantView api={api} startFresh initialDraft="Tab A 提问" />));
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="发送"]')!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="停止回答"]')!.click());
    await act(async () => {
      rejectSubmit(new TypeError("lost ack"));
      await Promise.resolve();
    });

    const reloadButton = () => Array.from(host.querySelectorAll("button")).find(b => b.textContent === "重新读取对话");
    const dismissButton = () => Array.from(host.querySelectorAll("button")).find(b => b.textContent === "继续提问");
    // First reread while Tab A's POST is still uncommitted (scoped lookup returns null and Tab A turn not in history):
    // must keep pendingStop armed and NOT adopt Tab B's stream.
    await act(async () => reloadButton()!.click());
    expect(getPendingJob).toHaveBeenCalledWith(id, expect.anything(), { clientKey: tabAClientKey });
    expect(cancelJob).not.toHaveBeenCalled();
    expect(getJob).not.toHaveBeenCalled();
    expect(reloadButton()).toBeTruthy();
    expect(dismissButton()).toBeTruthy();

    // 50ms later Tab A's POST commits; next reread finds Tab A's exact clientKey, cancels ONLY Tab A, and then adopts Tab B.
    tabAPhase = "running";
    await act(async () => reloadButton()!.click());
    expect(cancelJob.mock.calls).toEqual([[tabAJobId]]);
    expect(getJob).toHaveBeenCalledWith(tabBJobId, expect.anything());
    expect(dismissButton()).toBeUndefined();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it("clears Tab A's Stop marker and adopts Tab B only once scoped pending-job positively confirms Tab A is terminal", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const id = "19191919-1919-4919-8919-191919191919";
  const tabAJobId = "19191919-1919-4919-8919-191919191918";
  const tabBJobId = "20202020-2020-4020-8020-202020202020";
  const now = new Date().toISOString();
  let tabAClientKey = "";
  let rejectSubmit!: (reason?: unknown) => void;
  const submitPending = new Promise<never>((_resolve, reject) => { rejectSubmit = reject; });
  const submitTurn = vi.fn((input: { clientKey: string }) => {
    tabAClientKey = input.clientKey;
    return submitPending;
  });
  const cancelJob = vi.fn();
  const getJob = vi.fn(async (jobId: string) => ({ id: jobId, status: "running" as const, error: null, updatedAt: now }));
  let tabAStatus: "outcome_unknown" | "failed" = "outcome_unknown";
  const getPendingJob = vi.fn(async (_conversationId: string, _signal?: AbortSignal, options?: { clientKey?: string }) => {
    if (options?.clientKey) {
      return { id: tabAJobId, status: tabAStatus, error: null, updatedAt: now, clientKey: tabAClientKey };
    }
    return { id: tabBJobId, status: "running" as const, error: null, updatedAt: now };
  });
  const api = {
    listSources: async () => [],
    createConversation: vi.fn(async () => ({ id, title: "学习对话", courseId: null })),
    submitTurn,
    cancelJob,
    resumeConversation: async () => ({ conversationId: id, courseId: null, sourceIds: [], boundedHistory: [] }),
    listTurns: vi.fn(async () => [
      { id: "21212121-2121-4121-8121-212121212121", conversationId: id, role: "user" as const, text: "Tab A 提问", citations: [], createdAt: now, mode: "explain" as const, status: "complete" as const },
      { id: "22222222-2222-4222-8222-222222222221", conversationId: id, role: "assistant" as const, text: "已取消", citations: [], createdAt: now, mode: "explain" as const, status: "failed" as const },
    ]),
    getPendingJob,
    getJob,
  } as unknown as OpeningApi;
  try {
    await act(async () => root.render(<AssistantView api={api} startFresh initialDraft="Tab A 提问" />));
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="发送"]')!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="停止回答"]')!.click());
    await act(async () => {
      rejectSubmit(new TypeError("lost ack"));
      await Promise.resolve();
    });

    const reloadButton = () => Array.from(host.querySelectorAll("button")).find(b => b.textContent === "重新读取对话");
    const dismissButton = () => Array.from(host.querySelectorAll("button")).find(b => b.textContent === "继续提问");
    // While Tab A's scoped job is outcome_unknown, keep pendingStop armed and do not adopt Tab B.
    await act(async () => reloadButton()!.click());
    expect(getPendingJob).toHaveBeenCalledWith(id, expect.anything(), { clientKey: tabAClientKey });
    expect(cancelJob).not.toHaveBeenCalled();
    expect(getJob).not.toHaveBeenCalled();
    expect(dismissButton()).toBeTruthy();

    // Once Tab A's scoped job is positively confirmed terminal (failed/succeeded/cancelled), clear Stop and adopt Tab B.
    tabAStatus = "failed";
    await act(async () => reloadButton()!.click());
    expect(cancelJob).not.toHaveBeenCalled();
    expect(getJob).toHaveBeenCalledWith(tabBJobId, expect.anything());
    expect(dismissButton()).toBeUndefined();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it("refuses to cancel an active job when a skewed server omits clientKey on scoped pending-job discovery", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const id = "23232323-2323-4323-8323-232323232323";
  const tabBJobId = "24242424-2424-4424-8424-242424242424";
  const now = new Date().toISOString();
  let rejectSubmit!: (reason?: unknown) => void;
  const submitPending = new Promise<never>((_resolve, reject) => { rejectSubmit = reject; });
  const cancelJob = vi.fn();
  const getJob = vi.fn(async (jobId: string) => ({ id: jobId, status: "running" as const, error: null, updatedAt: now }));
  // Simulates an older server ignoring ?clientKey= and omitting clientKey from the JSON response.
  const getPendingJob = vi.fn(async () => ({ id: tabBJobId, status: "running" as const, error: null, updatedAt: now }));
  const api = {
    listSources: async () => [],
    createConversation: vi.fn(async () => ({ id, title: "学习对话", courseId: null })),
    submitTurn: vi.fn(() => submitPending),
    cancelJob,
    resumeConversation: async () => ({ conversationId: id, courseId: null, sourceIds: [], boundedHistory: [] }),
    listTurns: async () => [],
    getPendingJob,
    getJob,
  } as unknown as OpeningApi;
  try {
    await act(async () => root.render(<AssistantView api={api} startFresh initialDraft="Tab A 提问" />));
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="发送"]')!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="停止回答"]')!.click());
    await act(async () => {
      rejectSubmit(new TypeError("lost ack"));
      await Promise.resolve();
    });

    const reloadButton = Array.from(host.querySelectorAll("button")).find(b => b.textContent === "重新读取对话")!;
    await act(async () => reloadButton.click());
    expect(cancelJob).not.toHaveBeenCalled();
    expect(getJob).not.toHaveBeenCalled();
    expect(Array.from(host.querySelectorAll("button")).find(b => b.textContent === "重新读取对话")).toBeTruthy();
    expect(Array.from(host.querySelectorAll("button")).find(b => b.textContent === "继续提问")).toBeTruthy();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
