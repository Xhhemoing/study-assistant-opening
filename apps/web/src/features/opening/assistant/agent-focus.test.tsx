// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AssistantProposalRecord, LearningAttempt, TurnRecord } from "@aistudy/contracts";
import type { OpeningApi } from "../client/api";

const learning = vi.hoisted(() => ({ listObservations: vi.fn(), getAttemptContext: vi.fn() }));
const ownedApi = vi.hoisted(() => ({ value: null as OpeningApi | null }));
vi.mock("../client/api", async original => ({ ...await original<typeof import("../client/api")>(), createOpeningApi: () => ownedApi.value! }));
vi.mock("../client/learning-client", () => ({ createOpeningLearningClient: () => learning }));
vi.mock("./ai-readiness", () => ({ AiReadinessChecklist: () => null }));
vi.mock("../teaching/learner-state-card", () => ({ LearnerStateCard: () => null }));
vi.mock("../library/material-organization-client", () => ({ createMaterialOrganizationClient: () => ({ read: async () => ({ courses: [], memberships: [] }) }) }));
import { AssistantView } from "./assistant-view";
import { AgentWorkspace } from "./agent-workspace";
import { publishVerifiedSessionIdentity } from "../../auth/session-identity";

const conversation = "11111111-1111-4111-8111-111111111111";
const turn = "22222222-2222-4222-8222-222222222222";
const at = "2026-10-25T20:00:00Z";
const turns: TurnRecord[] = [{ id: turn, conversationId: conversation, role: "user", text: "请解释向量", status: "complete", mode: "explain", citations: [], createdAt: at }];
const proposal: AssistantProposalRecord = { id: turn, sourceTurnId: turn, version: 0, status: "draft", createdAt: at, basisVersion: "v1", result: null, prepared: null, tool: { name: "propose_note", arguments: { title: "向量笔记", text: "保留方向和长度" } } };
let root: Root, host: HTMLDivElement, clearIdentity: () => void;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  learning.listObservations.mockReset().mockResolvedValue([]);
  sessionStorage.clear();
  clearIdentity = publishVerifiedSessionIdentity({ id: "agent-focus-owner", workspaceId: conversation });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); clearIdentity(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function apiFor(rows: AssistantProposalRecord[] = []) {
  const state = { rows };
  const api = {
    listSources: vi.fn(async () => []), listConversations: vi.fn(async () => []),
    resumeConversation: vi.fn(async () => ({ conversationId: conversation, courseId: null, sourceIds: [], boundedHistory: [], historyTruncated: false })),
    listTurns: vi.fn(async () => turns), getPendingJob: vi.fn(async () => null),
    listPendingAssistantProposals: vi.fn(async () => ({ proposals: state.rows.filter(row => row.status === "draft"), total: state.rows.filter(row => row.status === "draft").length, nextCursor: null })),
    decideAssistantProposal: vi.fn(async () => { state.rows = state.rows.map(row => ({ ...row, status: "rejected" as const })); }),
    createConversation: vi.fn(), listTutorActions: vi.fn(async () => []),
    listCandidates: vi.fn(async () => []), listMemory: vi.fn(async () => ({ items: [] })),
  } as unknown as OpeningApi;
  ownedApi.value = api;
  return { api, state };
}
it.each([true, false])("carries the restored conversation through real citation links (agent=%s) and clears it for a fresh session", async agent => {
  const { api } = apiFor();
  const sourceId = "33333333-3333-4333-8333-333333333333";
  vi.mocked(api.listTurns).mockResolvedValue([{
    ...turns[0]!, role: "assistant", text: "向量具有方向和长度 [1]",
    citations: [{ sourceId, sourceVersion: 2, chunkId: turn, label: "1", page: 3 }],
  }]);
  await act(async () => root.render(<AssistantView api={api} agent={agent} initialConversationId={conversation} />));
  const links = Array.from(host.querySelectorAll<HTMLAnchorElement>('a[href*="source="]'));
  expect(links.length).toBeGreaterThan(0);
  for (const link of links) {
    const url = new URL(link.href);
    expect(url.searchParams.get("conversation")).toBe(conversation);
    expect(url.searchParams.get("source")).toBe(sourceId);
    expect(url.searchParams.get("version")).toBe("2");
    expect(url.searchParams.get("page")).toBe("3");
  }
  await act(async () => root.render(<AssistantView api={api} agent={agent} startFresh />));
  expect(host.querySelector('a[href*="conversation="]')).toBeNull();
  expect(host.querySelector('a[href*="source="]')).toBeNull();
});
it("keeps an explicitly supplied object link decorator in control of citation identity", async () => {
  const { api } = apiFor();
  vi.mocked(api.listTurns).mockResolvedValue([{
    ...turns[0]!, role: "assistant", text: "材料说明 [1]",
    citations: [{ sourceId: turn, sourceVersion: 2, chunkId: turn, label: "1", page: 3 }],
  }]);
  const objectHref = vi.fn((href: string) => `${href}&conversation=host-owned#selection`);
  await act(async () => root.render(<AssistantView api={api} agent initialConversationId={conversation} objectHref={objectHref} />));
  const links = Array.from(host.querySelectorAll<HTMLAnchorElement>('a[href*="source="]'));
  expect(links.length).toBeGreaterThan(0);
  for (const link of links) {
    expect(new URL(link.href).searchParams.get("conversation")).toBe("host-owned");
    expect(new URL(link.href).hash).toBe("#selection");
  }
});
it("keeps a fresh agent conversation free of a permanent proposal or memory sidebar", async () => {
  const { api } = apiFor();
  await act(async () => root.render(<AssistantView api={api} agent startFresh />));
  expect(host.querySelector('[aria-label="产出与待确认"]')).toBeNull();
  expect(host.textContent).not.toContain("暂无已确认记忆");
  expect(api.listCandidates).not.toHaveBeenCalled();
  expect(api.listMemory).not.toHaveBeenCalled();
});
it("reads proposals once and leaves the agent column full when no drafts await confirmation", async () => {
  const { api } = apiFor();
  await act(async () => root.render(<AssistantView api={api} agent initialConversationId={conversation} />));
  expect(api.listPendingAssistantProposals).toHaveBeenCalledOnce();
  expect(api.listPendingAssistantProposals).toHaveBeenCalledWith({ conversationId: conversation });
  expect(host.querySelector('[aria-label="产出与待确认"]')).toBeNull();
});
it("closes the pending sidebar when its last draft is decided in the inbox", async () => {
  const { api, state } = apiFor([proposal]);
  await act(async () => root.render(<AssistantView api={api} agent initialConversationId={conversation} />));
  expect(host.querySelector('[aria-label="产出与待确认"]')?.textContent).toContain("向量笔记");
  expect(api.listPendingAssistantProposals).toHaveBeenCalledOnce();
  expect(host.querySelector('a[href="/opening/suggestions"]')).not.toBeNull();
  expect(Array.from(host.querySelectorAll("button")).some(button => button.textContent === "不采用")).toBe(false);
  state.rows = [{ ...proposal, status: "rejected" }];
  await act(async () => window.dispatchEvent(new Event("opening:reviews-changed")));
  expect(api.decideAssistantProposal).not.toHaveBeenCalled();
  expect(host.querySelector('[aria-label="产出与待确认"]')).toBeNull();
});
it("keeps a visible retry in the conversation when proposal reading fails", async () => {
  const { api } = apiFor();
  vi.mocked(api.listPendingAssistantProposals).mockRejectedValueOnce(new Error("offline"));
  await act(async () => root.render(<AssistantView api={api} agent initialConversationId={conversation} />));
  expect(host.querySelector('[aria-label="产出与待确认"]')).toBeNull();
  const retry = Array.from(host.querySelectorAll("button")).find(button => button.textContent === "重新读取建议")!;
  expect(retry).toBeDefined();
  await act(async () => retry.click());
  expect(api.listPendingAssistantProposals).toHaveBeenCalledTimes(2);
});

it("blocks sending if a second owned snapshot reveals study context that was not prepared", async () => {
  const { api } = apiFor();
  vi.mocked(api.listTurns).mockResolvedValue([{ ...turns[0]!, contextAnchor: { purpose: "learning_help", activityId: conversation, blockId: turn, contentVersion: 1 } }]);
  await act(async () => root.render(<AssistantView api={api} agent initialConversationId={conversation} resumeBoundConversation initialDraft="请继续解释" />));
  expect(host.querySelector<HTMLButtonElement>('[aria-label="发送"]')?.disabled).toBe(true);
  expect(host.textContent).toContain("提问背景刚刚变化");
});
it("restores a saved question through the real workspace and session before sending with the same attempt and conversation", async () => {
  const courseId = "33333333-3333-4333-8333-333333333333";
  const attemptId = "44444444-4444-4444-8444-444444444444";
  const itemVersionId = "55555555-5555-4555-8555-555555555555";
  const sessionId = "66666666-6666-4666-8666-666666666666";
  const contextAnchor = { courseId, attemptId, itemVersionId, purpose: "learning_help" as const };
  const { api } = apiFor();
  vi.mocked(api.resumeConversation).mockResolvedValue({ conversationId: conversation, courseId, sourceIds: [], boundedHistory: [], historyTruncated: false });
  vi.mocked(api.listTurns).mockResolvedValue([{ ...turns[0]!, contextAnchor }]);
  const attempt: LearningAttempt = { id: attemptId, workspaceId: conversation, courseId, sessionId, itemVersionId, contextAnchor,
    skillLabel: "span", requirementKey: "span:v1", problemId: turn, sourceIds: [], sourceVersions: {}, startedAt: at,
    submittedAt: null, observationId: null, historyRevision: 1 };
  learning.getAttemptContext.mockResolvedValue({ attempt, deliveredAssistance: "hinted" });
  api.submitTurn = vi.fn(async () => ({ jobId: turn, turnId: turn, replayed: false }));
  api.getJob = vi.fn<OpeningApi["getJob"]>(async () => ({ id: turn, status: "succeeded", error: null, updatedAt: at }));
  await act(async () => root.render(<AgentWorkspace initialConversationId={conversation} />));
  const input = host.querySelector<HTMLTextAreaElement>('[aria-label="消息输入"]')!;
  expect(input).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "请提示下一步");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => input.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(learning.getAttemptContext).toHaveBeenCalledWith(attemptId);
  expect(api.createConversation).not.toHaveBeenCalled();
  expect(api.submitTurn).toHaveBeenCalledOnce();
  expect(vi.mocked(api.submitTurn).mock.calls[0]?.[0]).toMatchObject({ conversationId: conversation, attemptId, learningSessionId: sessionId, contextAnchor });
});
