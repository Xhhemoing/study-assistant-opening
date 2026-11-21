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

it("preserves pending Stop across a lost submitTurn ack and cancels the rediscovered job on reread", async () => {
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
  let runningOnServer = true;
  const createConversation = vi.fn(async () => ({ id, title: "学习对话", courseId: null }));
  const submitTurn = vi.fn(() => submitPending);
  const getJob = vi.fn(async () => ({ id: jobId, status: "running", error: null, updatedAt: new Date().toISOString() }));
  const cancelJob = vi.fn()
    .mockRejectedValueOnce(new TypeError("cancel network drop"))
    .mockImplementationOnce(async () => {
      runningOnServer = false;
      return { id: jobId, status: "cancelled", error: null, updatedAt: new Date().toISOString() };
    });
  const getPendingJob = vi.fn(async () => (
    runningOnServer
      ? { id: jobId, status: "running" as const, error: null, updatedAt: new Date().toISOString() }
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
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="停止回答"]')!.click());
    expect(host.textContent).toContain("正在等待确认后停止回答");

    // Simulate network drop after the server already committed the job.
    await act(async () => {
      rejectSubmit(new TypeError("lost ack"));
      await Promise.resolve();
    });
    expect(cancelJob).not.toHaveBeenCalled();
    expect(host.textContent).toContain("尚未确认发送结果，请重新读取对话");

    const reloadButton = () => Array.from(host.querySelectorAll("button")).find(b => b.textContent === "重新读取对话");
    expect(reloadButton()).toBeTruthy();

    // First reread discovers the running job and attempts cancel; cancel fails transiently so recovery remains available without resuming polling.
    await act(async () => reloadButton()!.click());
    expect(cancelJob.mock.calls).toEqual([[jobId]]);
    expect(getJob).not.toHaveBeenCalled();
    expect(reloadButton()).toBeTruthy();

    // Second reread retries cancel, succeeds, and settles without polling or streaming.
    await act(async () => reloadButton()!.click());
    expect(cancelJob.mock.calls).toEqual([[jobId], [jobId]]);
    expect(getJob).not.toHaveBeenCalled();
    expect(reloadButton()).toBeUndefined();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
