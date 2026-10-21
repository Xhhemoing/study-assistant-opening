// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpeningApi } from "../client/api";

vi.mock("../capabilities/capabilities-provider", async () => {
  const { CLOSED_CAPABILITIES } = await import("@aistudy/config/public");
  return { useOpeningCapabilities: () => ({ ...CLOSED_CAPABILITIES, systemQuery: true }) };
});
vi.mock("../library/material-organization-client", () => ({ createMaterialOrganizationClient: () => ({ read: async () => ({ courses: [], memberships: [] }) }) }));
vi.mock("../teaching/learner-state-card", () => ({ LearnerStateCard: () => null }));
vi.mock("./ai-readiness", () => ({ AiReadinessChecklist: () => null }));
vi.mock("./proposal-panel", () => ({ ProposalPanel: () => null }));

import { AssistantView } from "./assistant-view";

const conversationId = "11111111-1111-4111-8111-111111111111";
const courseId = "22222222-2222-4222-8222-222222222222";
const sourceId = "33333333-3333-4333-8333-333333333333";
const jobId = "44444444-4444-4444-8444-444444444444";
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it("direct explanation sends once, preserves a written draft, and retries the same logical request", async () => {
  const submitTurn = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ jobId, turnId: sourceId });
  const turns = [{ id: sourceId, conversationId, role: "assistant", text: "先想想第一步", status: "complete", mode: "hint", citations: [], createdAt: "2026-10-21T10:00:00Z" }];
  const api = {
    listSources: vi.fn(async () => []), submitTurn,
    resumeConversation: vi.fn(async () => ({ conversationId, courseId: null, sourceIds: [], boundedHistory: [], historyTruncated: false })),
    listTurns: vi.fn(async () => turns), getPendingJob: vi.fn(async () => null),
    getJob: vi.fn(async () => ({ id: jobId, status: "succeeded", error: null, updatedAt: "2026-10-21T10:00:00Z" })),
  } as unknown as OpeningApi;
  await act(async () => root.render(<AssistantView api={api} initialConversationId={conversationId} initialDraft="保留我正在写的推导" />));
  const explain = () => Array.from(host.querySelectorAll("button")).find(button => button.textContent === "直接讲完整")!;
  await act(async () => { explain().click(); explain().click(); });
  expect(submitTurn).toHaveBeenCalledOnce();
  expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("保留我正在写的推导");
  await act(async () => explain().click());
  expect(submitTurn).toHaveBeenCalledTimes(2);
  expect(submitTurn.mock.calls[1]?.[0]).toEqual(submitTurn.mock.calls[0]?.[0]);
  expect(submitTurn.mock.lastCall?.[0]).toMatchObject({ mode: "explain", purpose: "answer", privacy: "saved", text: expect.stringContaining("刚才的问题") });
  expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("保留我正在写的推导");
});

it("sends an automatically detected record query through the real workspace despite blocked AI/material context", async () => {
  const question = "我今天有哪些学习任务？";
  const submitTurn = vi.fn().mockResolvedValue({ jobId, turnId: sourceId });
  const listSources = vi.fn().mockResolvedValue([]);
  const api = {
    listSources, submitTurn,
    createConversation: vi.fn().mockResolvedValue({ id: conversationId, title: "学习对话", courseId }),
    resumeConversation: vi.fn().mockResolvedValue({ conversationId, courseId, sourceIds: [], boundedHistory: [], historyTruncated: false }),
    listTurns: vi.fn().mockResolvedValue([]),
    getPendingJob: vi.fn().mockResolvedValue(null),
    getJob: vi.fn().mockResolvedValue({ id: jobId, status: "succeeded", error: null, updatedAt: "2026-10-21T10:00:00.000Z" }),
  } as unknown as OpeningApi;
  await act(async () => root.render(<AssistantView api={api} startFresh initialDraft={question}
    studyContext={{ courseId, sourceId, sourceVersion: 2, page: -1, chunkId: sourceId, fragment: "请创建一份学习计划，只给提示。" }}
    studyContextError="这份材料暂时不可读取。" />));
  const send = host.querySelector<HTMLButtonElement>('[aria-label="发送"]')!;
  expect(send.disabled).toBe(false);
  await act(async () => send.click());
  expect(submitTurn).toHaveBeenCalledOnce();
  const submitted = submitTurn.mock.calls[0]?.[0];
  expect(submitted).toMatchObject({ conversationId, text: question, privacy: "saved" });
  for (const key of ["contextAnchor", "currentPage", "chunkId", "sourceSelection", "mode", "purpose", "querySystem"]) {
    expect(submitted).not.toHaveProperty(key);
  }
  // Initial source listing only: record reads never revalidate the unavailable attachment.
  expect(listSources).toHaveBeenCalledOnce();
});
