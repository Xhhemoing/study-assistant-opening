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

import { AssistantView } from "./assistant-view";

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
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
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
  const state = { turns: [user, assistant("failed")], pending: null };
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
