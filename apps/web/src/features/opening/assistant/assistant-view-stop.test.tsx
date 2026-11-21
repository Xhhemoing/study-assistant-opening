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
  const getPendingJob = vi.fn(async () => (
    serverPhase === "running"
      ? { id: jobId, status: "running" as const, error: null, updatedAt: new Date().toISOString(), clientKey: submittedClientKey }
      : null
  ));
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
    // Must NOT cancel the other tab's job; should adopt normal active state instead.
    expect(cancelJob).not.toHaveBeenCalled();
    expect(getJob).toHaveBeenCalledWith(otherJobId, expect.anything());
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it("clears pendingStop when reread sees our clientKey already settled as a terminal turn or when recovery is dismissed", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const id = "66666666-6666-4666-8666-666666666666";
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
  let turnsReturned = false;
  const api = {
    listSources: async () => [],
    createConversation,
    submitTurn,
    cancelJob,
    resumeConversation: async () => ({ conversationId: id, courseId: null, sourceIds: [], boundedHistory: [] }),
    listTurns: async () => (turnsReturned ? [
      { id: "77777777-7777-4777-8777-777777777777", conversationId: id, role: "user" as const, text: "原始提问", citations: [], createdAt: now, mode: "explain" as const, status: "complete" as const, clientKey: submittedClientKey },
      { id: "88888888-8888-4888-8888-888888888888", conversationId: id, role: "assistant" as const, text: "已完成回答", citations: [], createdAt: now, mode: "explain" as const, status: "complete" as const },
    ] : []),
    getPendingJob: async () => null,
    getJob: async () => ({ id: "job", status: "succeeded", error: null, updatedAt: now }),
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
    // While turn has not appeared, recovery + dismiss stay available.
    await act(async () => reloadButton()!.click());
    expect(reloadButton()).toBeTruthy();
    expect(dismissButton()).toBeTruthy();

    // Once the terminal turn for our clientKey appears, pendingStop & recovery clear automatically.
    turnsReturned = true;
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
