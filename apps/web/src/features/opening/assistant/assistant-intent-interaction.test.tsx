// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LearningAttempt } from "@aistudy/contracts";
import type { OpeningApi } from "../client/api";

const readiness = vi.hoisted(() => ({ blocked: true }));
vi.mock("../capabilities/capabilities-provider", async () => {
  const { CLOSED_CAPABILITIES } = await import("@aistudy/config/public");
  return { useOpeningCapabilities: () => ({ ...CLOSED_CAPABILITIES, systemQuery: true }) };
});
vi.mock("../library/material-organization-client", () => ({ createMaterialOrganizationClient: () => ({ read: async () => ({ courses: [], memberships: [] }) }) }));
vi.mock("../teaching/learner-state-card", () => ({ LearnerStateCard: () => null }));
vi.mock("./ai-readiness", async () => {
  const { useEffect } = await import("react");
  return { AiReadinessChecklist: ({ onBlockedChange }: { onBlockedChange?: (value: boolean) => void }) => {
    useEffect(() => { onBlockedChange?.(readiness.blocked); }, [onBlockedChange]);
    return null;
  } };
});
vi.mock("./proposal-panel", () => ({ ProposalPanel: () => null }));

import { AssistantView } from "./assistant-view";
import { MessageActions } from "./message-actions";
import { publishVerifiedSessionIdentity } from "../../auth/session-identity";

const conversationId = "11111111-1111-4111-8111-111111111111";
const courseId = "22222222-2222-4222-8222-222222222222";
const sourceId = "33333333-3333-4333-8333-333333333333";
const jobId = "44444444-4444-4444-8444-444444444444";
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  readiness.blocked = true;
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

it("maps the four explanation controls to existing reply modes and draft callbacks", async () => {
  const reply = vi.fn(), prompt = vi.fn(), save = vi.fn();
  await act(async () => root.render(<MessageActions text="原回答" onReplyMode={reply} onPrompt={prompt} onSave={save} />));
  for (const label of ["我没懂", "举个例子", "讲快点", "讲细点"]) {
    const action = Array.from(host.querySelectorAll("button")).find(button => button.textContent === label);
    expect(action, label).toBeDefined();
    await act(async () => action!.click());
  }
  expect(reply.mock.calls).toEqual([["hint"], ["explain"]]);
  expect(prompt.mock.calls[0]?.[0]).toContain("具体例子");
  expect(prompt.mock.calls[1]?.[0]).toContain("讲快");
  expect(save).not.toHaveBeenCalled();
  await act(async () => Array.from(host.querySelectorAll("button")).find(button => button.textContent === "保存")!.click());
  expect(save).toHaveBeenCalledOnce();
});

it.each(["mode", "draft", "none"] as const)("only exposes explanation actions with actual %s callbacks", async kind => {
  await act(async () => root.render(<MessageActions text="原回答" onReplyMode={kind === "mode" ? vi.fn() : undefined} onPrompt={kind === "draft" ? vi.fn() : undefined} />));
  const labels = Array.from(host.querySelectorAll("button")).map(button => button.textContent);
  expect(labels.includes("我没懂")).toBe(kind === "mode");
  expect(labels.includes("讲细点")).toBe(kind === "mode");
  expect(labels.includes("举个例子")).toBe(kind === "draft");
  expect(labels.includes("讲快点")).toBe(kind === "draft");
});

it.each(["举个例子", "讲快点"])("prepares %s in the guarded draft without sending", async label => {
  readiness.blocked = false;
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  const submitTurn = vi.fn();
  const api = {
    listSources: vi.fn(async () => []), submitTurn,
    resumeConversation: vi.fn(async () => ({ conversationId, courseId: null, sourceIds: [], boundedHistory: [], historyTruncated: false })),
    listTurns: vi.fn(async () => [{ id: sourceId, conversationId, role: "assistant", text: "矩阵秩是列空间的维数", status: "complete", citations: [], createdAt: "2026-10-21T10:00:00Z" }]),
    getPendingJob: vi.fn(async () => null),
  } as unknown as OpeningApi;
  await act(async () => root.render(<AssistantView api={api} initialConversationId={conversationId} initialDraft="保留我原先的问题" />));
  const button = Array.from(host.querySelectorAll("button")).find(item => item.textContent === label)!;
  await act(async () => button.click());
  expect(confirm).toHaveBeenCalledOnce();
  expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("保留我原先的问题");
  confirm.mockReturnValue(true);
  await act(async () => button.click());
  expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toContain(label === "举个例子" ? "具体例子" : "讲快");
  expect(submitTurn).not.toHaveBeenCalled();
});

it.each(["explain", "composer"] as const)("shares the send lock during source preflight when %s starts first", async first => {
  readiness.blocked = false;
  const sources = [{ id: sourceId, name: "线代讲义", version: 1, uploadState: "uploaded", parseState: "ready" }];
  let finishPreflight!: (value: unknown) => void;
  const preflight = new Promise(resolve => { finishPreflight = resolve; });
  const listSources = vi.fn().mockResolvedValueOnce(sources).mockReturnValue(preflight);
  const submitTurn = vi.fn<OpeningApi["submitTurn"]>(async () => ({ jobId, turnId: sourceId }));
  const turns = [{ id: sourceId, conversationId, role: "assistant", text: "先想想第一步", status: "complete", mode: "hint", citations: [], createdAt: "2026-10-21T10:00:00Z" }];
  const api = {
    listSources, submitTurn,
    resumeConversation: vi.fn(async () => ({ conversationId, courseId: null, sourceIds: [sourceId], boundedHistory: [], historyTruncated: false })),
    listTurns: vi.fn(async () => turns), getPendingJob: vi.fn(async () => null),
    getJob: vi.fn(async () => ({ id: jobId, status: "succeeded", error: null, updatedAt: "2026-10-21T10:00:00Z" })),
  } as unknown as OpeningApi;
  await act(async () => root.render(<AssistantView api={api} initialConversationId={conversationId}
    studyContext={{ sourceId, sourceVersion: 1 }} initialDraft="我自己的推导" />));
  const explain = () => Array.from(host.querySelectorAll("button")).find(button => button.textContent === "讲细点")!;
  const composer = () => host.querySelector<HTMLButtonElement>('[aria-label="发送"]')!;
  await act(async () => { (first === "explain" ? explain() : composer()).click(); });
  expect(submitTurn).not.toHaveBeenCalled();
  await act(async () => { (first === "explain" ? composer() : explain()).click(); });
  expect(listSources).toHaveBeenCalledTimes(2);
  await act(async () => { finishPreflight(sources); });
  expect(submitTurn).toHaveBeenCalledOnce();
  expect(submitTurn.mock.calls[0]?.[0]).toMatchObject({ text: first === "explain" ? expect.stringContaining("刚才的问题") : "我自己的推导" });
  expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(first === "explain" ? "我自己的推导" : "");
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
  const explain = () => Array.from(host.querySelectorAll("button")).find(button => button.textContent === "讲细点")!;
  await act(async () => { explain().click(); explain().click(); });
  expect(submitTurn).toHaveBeenCalledOnce();
  expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("保留我正在写的推导");
  await act(async () => explain().click());
  expect(submitTurn).toHaveBeenCalledTimes(2);
  expect(submitTurn.mock.calls[1]?.[0]).toEqual(submitTurn.mock.calls[0]?.[0]);
  expect(submitTurn.mock.lastCall?.[0]).toMatchObject({ mode: "explain", purpose: "answer", privacy: "saved", text: expect.stringContaining("刚才的问题") });
  expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("保留我正在写的推导");
});

it("uses a new direct-explanation request when the help scope changes after a failed response", async () => {
  readiness.blocked = false;
  const attempt: LearningAttempt = {
    id: sourceId, workspaceId: sourceId, sessionId: sourceId, courseId,
    skillLabel: "向量", requirementKey: null, problemId: sourceId, itemVersionId: null,
    sourceIds: [], sourceVersions: {}, startedAt: "2026-10-21T10:00:00Z",
    submittedAt: null, observationId: null, historyRevision: 1,
  };
  const submitTurn = vi.fn<OpeningApi["submitTurn"]>()
    .mockResolvedValueOnce({ jobId, turnId: sourceId })
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce({ jobId, turnId: sourceId });
  const api = {
    listSources: vi.fn(async () => []), submitTurn, listTutorActions: vi.fn(async () => []),
    createConversation: vi.fn(async () => ({ id: conversationId, title: "练习", courseId })),
    resumeConversation: vi.fn(async () => ({ conversationId, courseId, sourceIds: [], boundedHistory: [], historyTruncated: false })),
    listTurns: vi.fn(async () => [{ id: sourceId, conversationId, role: "assistant", text: "先想想第一步", status: "complete", mode: "hint", citations: [], createdAt: "2026-10-21T10:00:00Z" }]),
    getPendingJob: vi.fn(async () => null),
    getJob: vi.fn(async () => ({ id: jobId, status: "succeeded", error: null, updatedAt: "2026-10-21T10:00:00Z" })),
  } as unknown as OpeningApi;
  await act(async () => root.render(<AssistantView api={api} learningAttempt={attempt}
    studyContext={{ courseId, attemptId: attempt.id }} initialDraft="这一题怎么开始？" />));
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="发送"]')!.click());
  const explain = () => Array.from(host.querySelectorAll("button")).find(button => button.textContent === "讲细点")!;
  await act(async () => explain().click());
  const scope = Array.from(host.querySelectorAll("select")).find(select => select.querySelector('[value="language_support"]'))!;
  await act(async () => { scope.value = "language_support"; scope.dispatchEvent(new Event("change", { bubbles: true })); });
  await act(async () => explain().click());
  expect(submitTurn).toHaveBeenCalledTimes(3);
  const original = submitTurn.mock.calls[1]![0], changed = submitTurn.mock.calls[2]![0];
  expect(original.contextAnchor?.purpose).toBe("learning_help");
  expect(changed.contextAnchor?.purpose).toBe("language_support");
  expect(changed.clientKey).not.toBe(original.clientKey);
});

it("releases the shared lock when source preflight rejects the send", async () => {
  const sources = [{ id: sourceId, name: "线代讲义", version: 1, uploadState: "uploaded", parseState: "ready" }];
  const listSources = vi.fn().mockResolvedValueOnce(sources).mockResolvedValueOnce([]).mockResolvedValue(sources);
  const submitTurn = vi.fn(async () => ({ jobId, turnId: sourceId }));
  const api = {
    listSources, submitTurn,
    resumeConversation: vi.fn(async () => ({ conversationId, courseId: null, sourceIds: [sourceId], boundedHistory: [], historyTruncated: false })),
    listTurns: vi.fn(async () => [{ id: sourceId, conversationId, role: "assistant", text: "先想想第一步", status: "complete", mode: "hint", citations: [], createdAt: "2026-10-21T10:00:00Z" }]),
    getPendingJob: vi.fn(async () => null),
    getJob: vi.fn(async () => ({ id: jobId, status: "succeeded", error: null, updatedAt: "2026-10-21T10:00:00Z" })),
  } as unknown as OpeningApi;
  await act(async () => root.render(<AssistantView api={api} initialConversationId={conversationId}
    studyContext={{ sourceId, sourceVersion: 1 }} initialDraft="我的草稿" />));
  const explain = () => Array.from(host.querySelectorAll("button")).find(button => button.textContent === "讲细点")!;
  await act(async () => explain().click());
  expect(submitTurn).not.toHaveBeenCalled();
  expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("我的草稿");
  await act(async () => explain().click());
  expect(submitTurn).toHaveBeenCalledOnce();
  expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("我的草稿");
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

it("appends each native selection request once to the restored draft without sending or rebinding context", async () => {
  const clearIdentity = publishVerifiedSessionIdentity({ id: "selection-owner", workspaceId: "selection-workspace" });
  const submitTurn = vi.fn(), createConversation = vi.fn();
  const api = { listSources: vi.fn(async () => []), submitTurn, createConversation } as unknown as OpeningApi;
  const context = { activityId: crypto.randomUUID(), blockId: crypto.randomUUID(), contentVersion: 2, label: "原段落" };
  const props = { api, embedded: true, startFresh: true, studyContext: context, initialDraft: "我的未完成推导" };
  await act(async () => root.render(<AssistantView {...props} />));
  const field = () => host.querySelector<HTMLTextAreaElement>("textarea")!;
  const request = { id: "selection-1", text: "请补充解释这段内容：\n原文第一段" };
  await act(async () => root.render(<AssistantView {...props} promptRequest={request} />));
  expect(field().value).toBe(`我的未完成推导\n\n${request.text}`);
  await act(async () => root.render(<AssistantView {...props} promptRequest={{ ...request }} />));
  expect(field().value).toBe(`我的未完成推导\n\n${request.text}`);
  await act(async () => root.render(null));
  const next = { id: "selection-2", text: "请补充解释这段内容：\n新选区" };
  await act(async () => root.render(<AssistantView {...props} promptRequest={next} />));
  expect(field().value).toBe(`我的未完成推导\n\n${request.text}\n\n${next.text}`);
  expect(submitTurn).not.toHaveBeenCalled(); expect(createConversation).not.toHaveBeenCalled();
  clearIdentity();
});
