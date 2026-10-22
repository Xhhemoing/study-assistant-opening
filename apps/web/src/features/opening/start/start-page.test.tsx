// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpeningApi } from "../client/api";
import { publishVerifiedSessionIdentity } from "../../auth/session-identity";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
vi.mock("next/link", () => ({ default: ({ href, onClick, ...props }: ComponentProps<"a">) => <a {...props} href={href} onClick={event => {
  onClick?.(event); event.preventDefault(); if (href && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) window.history.pushState(window.history.state, "", href);
}} /> }));
vi.mock("../capabilities/capabilities-provider", async () => {
  const { CLOSED_CAPABILITIES } = await import("@aistudy/config/public");
  return { useOpeningCapabilities: () => ({ ...CLOSED_CAPABILITIES, systemQuery: true }) };
});
vi.mock("../library/material-organization-client", () => ({ createMaterialOrganizationClient: () => ({ read: async () => ({ courses: [], memberships: [] }) }) }));
vi.mock("../teaching/learner-state-card", () => ({ LearnerStateCard: () => null }));
vi.mock("../assistant/ai-readiness", async () => {
  const { useEffect } = await import("react");
  return { AiReadinessChecklist: ({ onBlockedChange }: { onBlockedChange?: (value: boolean) => void }) => { useEffect(() => onBlockedChange?.(false), [onBlockedChange]); return null; } };
});
vi.mock("../assistant/proposal-panel", () => ({ ProposalPanel: () => null }));
vi.mock("../assistant/use-job-stream", () => ({ useJobStream: () => ({ reply: null, cancel() {} }) }));
import { StartPage } from "./start-page";
import { AssistantView } from "../assistant/assistant-view";
import { ConversationCompanionProvider, ConversationSurface, OriginalConversationSlot } from "../assistant/conversation-companion";
import { assistantContextScope } from "../assistant/assistant-view";
import { createQuestionDraftStore } from "../assistant/question-drafts";

const conversationId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";
let host: HTMLDivElement, root: Root, clearIdentity: () => void;
let sessionSequence = 0;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  sessionStorage.clear(); window.history.replaceState(null, "", "/opening/today");
  clearIdentity = publishVerifiedSessionIdentity({ id: `student-${++sessionSequence}`, workspaceId: "workspace" });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ count: 9 })));
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); clearIdentity(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function apiFixture(pending = true) {
  return {
    listTeachingActivities: vi.fn(async () => []), listTasks: vi.fn(async () => ({ tasks: [] })), listSources: vi.fn(async () => []),
    createConversation: vi.fn(async () => ({ id: conversationId, title: "新问题", courseId: null })),
    submitTurn: vi.fn(async () => ({ jobId, turnId: jobId })),
    resumeConversation: vi.fn(async () => ({ conversationId, courseId: null, sourceIds: [], boundedHistory: [], historyTruncated: false })),
    listTurns: vi.fn(async () => [{ id: jobId, conversationId, role: "user", text: "为什么？", status: "complete", citations: [], createdAt: "2026-10-22T10:00:00Z" }]),
    getPendingJob: vi.fn(async () => pending ? { id: jobId, status: "queued", error: null, updatedAt: "2026-10-22T10:00:00Z" } : null),
    getJob: vi.fn(async () => ({ id: jobId, status: pending ? "queued" : "succeeded", error: null, updatedAt: "2026-10-22T10:00:00Z" })), cancelJob: vi.fn(),
  } as unknown as OpeningApi;
}
async function edit(text: string) {
  const input = host.querySelector<HTMLTextAreaElement>("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function send() { await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))); }

it("reads only metadata for due suggestions and preserves one mounted conversation while the first answer is pending", async () => {
  const api = apiFixture();
  await act(async () => root.render(<StartPage state={{ kind: "empty", courses: { status: "ready", items: [] } }} timeZone="Asia/Shanghai" api={api} />));
  expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/reviews/count", expect.objectContaining({ cache: "no-store" }));
  expect(host.textContent).toContain("复习 9 项");
  expect(api.createConversation).not.toHaveBeenCalled();
  const textarea = host.querySelector("textarea");
  await edit("为什么？"); await send();
  expect(api.createConversation).toHaveBeenCalledOnce(); expect(api.submitTurn).toHaveBeenCalledOnce();
  expect(window.location.pathname).toBe("/opening/today"); expect(new URLSearchParams(window.location.search).get("conversation")).toBe(conversationId);
  expect(host.querySelector("textarea")).toBe(textarea);
  expect(host.querySelector('[aria-label="停止回答"]')).not.toBeNull();
  await send(); expect(api.submitTurn).toHaveBeenCalledOnce();
  await act(async () => host.querySelector<HTMLAnchorElement>('[aria-label="新对话"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true })));
  expect(host.querySelector("textarea")).toBe(textarea); expect(host.querySelector('[aria-label="停止回答"]')).not.toBeNull();
  await act(async () => host.querySelector<HTMLAnchorElement>('[aria-label="新对话"]')!.click());
  expect(window.location.pathname + window.location.search).toBe("/opening/today");
  expect(host.textContent).toContain("你好，今天想学什么？"); expect(host.textContent).not.toContain("为什么？");
  expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("");
  expect(api.cancelJob).not.toHaveBeenCalled(); expect(api.createConversation).toHaveBeenCalledOnce();
});

it("restores a follow-up draft under the created conversation after refresh", async () => {
  const api = apiFixture(false);
  await act(async () => root.render(<StartPage state={{ kind: "empty" }} timeZone="Asia/Shanghai" api={api} />));
  await edit("为什么？"); await send();
  await edit("保留我正在写的追问");
  await act(async () => root.render(<AssistantView api={api} initialConversationId={conversationId} />));
  expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("保留我正在写的追问");
  expect(api.submitTurn).toHaveBeenCalledOnce();
});

it("publishes a created conversation before a failed send so refresh preserves the unsent question", async () => {
  const api = apiFixture(false);
  vi.mocked(api.submitTurn).mockRejectedValueOnce(new Error("发送未确认"));
  await act(async () => root.render(<StartPage state={{ kind: "empty" }} timeZone="Asia/Shanghai" api={api} />));
  await edit("失败也保留这道题"); await send();
  expect(new URLSearchParams(window.location.search).get("conversation")).toBe(conversationId);
  expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("失败也保留这道题");
  await act(async () => root.render(<AssistantView api={api} initialConversationId={conversationId} />));
  expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("失败也保留这道题");
  expect(api.submitTurn).toHaveBeenCalledOnce();
});

it("does not let a late conversation creation remove the next start session's draft or change its URL", async () => {
  const api = apiFixture(false);
  let finishCreate!: (value: Awaited<ReturnType<OpeningApi["createConversation"]>>) => void;
  vi.mocked(api.createConversation).mockReturnValueOnce(new Promise(resolve => { finishCreate = resolve; }));
  await act(async () => root.render(<StartPage state={{ kind: "empty" }} timeZone="Asia/Shanghai" api={api} />));
  await edit("上一条正在提交的问题"); await send();
  await act(async () => host.querySelector<HTMLAnchorElement>('[aria-label="新对话"]')!.click());
  await edit("新对话的未发送草稿");
  await act(async () => finishCreate({ id: conversationId, title: "上一条", courseId: null }));
  expect(window.location.search).toBe("");
  expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("新对话的未发送草稿");
  await act(async () => root.render(<StartPage key="refresh" state={{ kind: "empty" }} timeZone="Asia/Shanghai" api={api} />));
  expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("新对话的未发送草稿");
  expect(api.createConversation).toHaveBeenCalledOnce(); expect(api.submitTurn).toHaveBeenCalledOnce();
});

it.each([{ count: -1 }, { count: "9" }, { count: 1.5 }])("does not invent a due count from invalid metadata %j", async body => {
  vi.mocked(fetch).mockResolvedValueOnce(Response.json(body));
  await act(async () => root.render(<StartPage state={{ kind: "empty" }} timeZone="Asia/Shanghai" api={apiFixture()} />));
  expect(host.textContent).toContain("部分学习记录暂时无法读取"); expect(host.textContent).not.toMatch(/复习 [0-9]+ 项/);
});

it("keeps the same pending chat DOM, draft and request when navigating to an object's slot and back", async () => {
  const api = apiFixture();
  function Route({ page }: { page: "start" | "object" | "conversation" }) {
    return <ConversationCompanionProvider>{page === "object"
      ? <section><h1>另一门课程的内容</h1><OriginalConversationSlot conversationId={conversationId} /></section>
      : page === "conversation" ? <ConversationSurface api={api} initialConversationId={conversationId} />
        : <StartPage state={{ kind: "empty" }} timeZone="Asia/Shanghai" api={api} />}</ConversationCompanionProvider>;
  }
  await act(async () => root.render(<Route page="start" />));
  const original = host.querySelector<HTMLTextAreaElement>("textarea")!;
  await edit("为什么？"); await send();
  expect(original.disabled).toBe(true);
  await act(async () => { window.history.pushState(null, "", `/opening/courses/33333333-3333-4333-8333-333333333333/study?conversation=${conversationId}`); root.render(<Route page="object" />); });
  expect(host.querySelector(`[data-original-conversation="${conversationId}"] textarea`)).toBe(original);
  expect(host.querySelectorAll("h1")).toHaveLength(1);
  expect(api.listSources).toHaveBeenCalledOnce(); expect(api.createConversation).toHaveBeenCalledOnce(); expect(api.submitTurn).toHaveBeenCalledOnce();
  expect(host.querySelector('[aria-label="停止回答"]')).not.toBeNull();
  await act(async () => { window.history.replaceState(null, "", `/opening/today?conversation=${conversationId}`); root.render(<Route page="conversation" />); });
  expect(host.querySelector("textarea")).toBe(original); expect(api.listSources).toHaveBeenCalledOnce();
  expect(api.cancelJob).not.toHaveBeenCalled();
});

it("restores a known conversation to a right slot and back without changing its original course, sources or draft", async () => {
  const api = apiFixture(false);
  const sourceId = "44444444-4444-4444-8444-444444444444";
  const courseId = "55555555-5555-4555-8555-555555555555";
  vi.mocked(api.listSources).mockResolvedValue([{ id: sourceId, name: "原课程材料", mime: "text/plain", version: 1, uploadState: "uploaded", parseState: "ready" }] as Awaited<ReturnType<OpeningApi["listSources"]>>);
  vi.mocked(api.resumeConversation).mockResolvedValue({ conversationId, courseId, sourceIds: [sourceId], boundedHistory: [], historyTruncated: false });
  function Route({ object }: { object: boolean }) {
    return <ConversationCompanionProvider>{object ? <OriginalConversationSlot conversationId={conversationId} /> : <ConversationSurface api={api} initialConversationId={conversationId} />}</ConversationCompanionProvider>;
  }
  await act(async () => root.render(<Route object={false} />));
  const original = host.querySelector<HTMLTextAreaElement>("textarea")!; await edit("跨页面保留这段未发送内容");
  original.focus(); original.setSelectionRange(3, 6);
  const log = host.querySelector<HTMLElement>('[role="log"]')!; log.scrollTop = 80;
  await act(async () => root.render(<Route object />));
  expect(host.querySelector("textarea")).toBe(original);
  expect(document.activeElement).toBe(original); expect(original.selectionStart).toBe(3); expect(log.scrollTop).toBe(80);
  expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("跨页面保留这段未发送内容");
  await act(async () => root.render(<Route object={false} />));
  expect(host.querySelector("textarea")).toBe(original); expect(api.resumeConversation).toHaveBeenCalledOnce();
  await send();
  expect(api.createConversation).not.toHaveBeenCalled();
  expect(vi.mocked(api.submitTurn).mock.lastCall?.[0]).toMatchObject({ conversationId, sourceIds: [sourceId] });
  expect(vi.mocked(api.submitTurn).mock.lastCall?.[0].contextAnchor).toBeUndefined();
  expect(vi.mocked(api.submitTurn).mock.lastCall?.[0].attemptId).toBeUndefined();
});

it("promotes a late created id into one original chat without enabling a duplicate restored editor", async () => {
  const api = apiFixture(false);
  let finishCreate!: (value: Awaited<ReturnType<OpeningApi["createConversation"]>>) => void;
  vi.mocked(api.createConversation).mockReturnValueOnce(new Promise(resolve => { finishCreate = resolve; }));
  function Route({ known }: { known: boolean }) {
    return <ConversationCompanionProvider>{known ? <ConversationSurface api={api} initialConversationId={conversationId} /> : <StartPage state={{ kind: "empty" }} timeZone="Asia/Shanghai" api={api} />}</ConversationCompanionProvider>;
  }
  await act(async () => root.render(<Route known={false} />));
  const original = host.querySelector("textarea"); await edit("原始提交的问题"); await send();
  await act(async () => root.render(<Route known />));
  const duplicate = host.querySelector<HTMLElement>('[data-conversation-surface]')!;
  expect(duplicate.querySelector<HTMLTextAreaElement>("textarea")?.disabled).toBe(true);
  expect(duplicate.querySelector("section[inert]")).not.toBeNull();
  for (const button of duplicate.querySelectorAll<HTMLButtonElement>('[aria-label="选择参考材料"],button')) {
    if (button.textContent === "拍题" || button.textContent === "上传" || button.getAttribute("aria-label") === "选择参考材料") expect(button.disabled).toBe(true);
  }
  await act(async () => finishCreate({ id: conversationId, title: "新问题", courseId: null }));
  expect(host.querySelector("textarea")).toBe(original); expect(host.querySelectorAll("textarea")).toHaveLength(1);
  expect(api.createConversation).toHaveBeenCalledOnce(); expect(api.submitTurn).toHaveBeenCalledOnce();
  expect(api.cancelJob).not.toHaveBeenCalled();
});

it("does not load a prior conversation when a slot has no explicit id or the id is invalid", async () => {
  await act(async () => root.render(<ConversationCompanionProvider><OriginalConversationSlot /><OriginalConversationSlot conversationId="invalid" /></ConversationCompanionProvider>));
  expect(host.textContent).toContain("原对话链接无效"); expect(host.querySelector("textarea")).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

it("restores an unknown explicit id through server authorization and never falls back to another conversation after denial", async () => {
  vi.mocked(fetch).mockImplementation(async input => String(input) === "/api/opening/sources"
    ? Response.json([]) : Response.json({ error: { code: "NOT_FOUND", message: "无权读取原对话" } }, { status: 403 }));
  await act(async () => root.render(<ConversationCompanionProvider><OriginalConversationSlot conversationId={conversationId} /></ConversationCompanionProvider>));
  const paths = vi.mocked(fetch).mock.calls.map(([input]) => String(input));
  expect(paths).toContain(`/api/opening/conversations/${conversationId}/resume`);
  expect(paths).not.toContain("/api/opening/conversations");
  expect(host.textContent).toContain("无权读取原对话");
  expect(host.querySelector<HTMLButtonElement>('[aria-label="发送"]')?.disabled).toBe(true);
});

it("bounds completed parked conversations while keeping an in-flight conversation mounted", async () => {
  const api = apiFixture(false);
  const ids = Array.from({ length: 12 }, (_, index) => `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`);
  vi.mocked(api.resumeConversation).mockImplementation(async id => ({ conversationId: id, courseId: null, sourceIds: [], boundedHistory: [], historyTruncated: false }));
  vi.mocked(api.listTurns).mockResolvedValue([]);
  vi.mocked(api.getPendingJob).mockImplementation(async id => id === ids[0] ? { id: jobId, status: "queued", error: null, updatedAt: "2026-10-22T10:00:00Z" } : null);
  vi.mocked(api.getJob).mockResolvedValue({ id: jobId, status: "queued", error: null, updatedAt: "2026-10-22T10:00:00Z" });
  function Route({ id }: { id: string }) { return <ConversationCompanionProvider><ConversationSurface api={api} initialConversationId={id} /></ConversationCompanionProvider>; }
  await act(async () => root.render(<Route id={ids[0]!} />));
  const pendingInput = host.querySelector("textarea");
  for (const id of ids.slice(1)) await act(async () => root.render(<Route id={id} />));
  // One active view, eight completed idle views, and the protected in-flight view.
  expect(host.querySelectorAll("textarea")).toHaveLength(10);
  await act(async () => root.render(<Route id={ids[0]!} />));
  expect(host.querySelector('[data-conversation-surface] textarea')).toBe(pendingInput);
  expect(vi.mocked(api.resumeConversation).mock.calls.filter(([id]) => id === ids[0])).toHaveLength(1);
  await act(async () => root.render(<Route id={ids[1]!} />));
  expect(vi.mocked(api.resumeConversation).mock.calls.filter(([id]) => id === ids[1])).toHaveLength(2);
  expect(api.cancelJob).not.toHaveBeenCalled(); expect(api.submitTurn).not.toHaveBeenCalled();
});

it("keeps the new start draft in storage when a parked first creation and its migration effect finish late", async () => {
  const api = apiFixture(false);
  let finishCreate!: (value: Awaited<ReturnType<OpeningApi["createConversation"]>>) => void;
  vi.mocked(api.createConversation).mockReturnValueOnce(new Promise(resolve => { finishCreate = resolve; }));
  await act(async () => root.render(<ConversationCompanionProvider><StartPage state={{ kind: "empty" }} timeZone="Asia/Shanghai" api={api} /></ConversationCompanionProvider>));
  await edit("先前正在保存的问题"); await send();
  await act(async () => host.querySelector<HTMLAnchorElement>('[aria-label="新对话"]')!.click());
  expect(host.querySelector<HTMLTextAreaElement>('[data-conversation-surface] textarea')?.value).toBe("");
  await edit("新开始页的独立草稿");
  await act(async () => finishCreate({ id: conversationId, title: "先前的问题", courseId: null }));
  expect(window.location.search).toBe("");
  expect(host.querySelector<HTMLTextAreaElement>('[data-conversation-surface] textarea')?.value).toBe("新开始页的独立草稿");
  expect(createQuestionDraftStore().read(`${assistantContextScope()}:::::`)).toBe("新开始页的独立草稿");
  expect(Object.values(sessionStorage).some(value => String(value).includes("新开始页的独立草稿"))).toBe(true);
  await act(async () => root.render(<StartPage state={{ kind: "empty" }} timeZone="Asia/Shanghai" api={api} />));
  expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("新开始页的独立草稿");
  expect(api.submitTurn).toHaveBeenCalledOnce();
});

it("protects a saved conversation's unsent page selection from idle eviction without changing source mode", async () => {
  vi.mocked(matchMedia).mockReturnValue({ matches: true, addEventListener() {}, removeEventListener() {} } as unknown as MediaQueryList);
  const api = apiFixture(false);
  const ids = Array.from({ length: 12 }, (_, index) => `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`);
  const sourceId = "44444444-4444-4444-8444-444444444444";
  vi.mocked(api.listSources).mockResolvedValue([{ id: sourceId, name: "页码材料", mime: "application/pdf", version: 1, uploadState: "uploaded", parseState: "ready" }] as Awaited<ReturnType<OpeningApi["listSources"]>>);
  vi.mocked(api.resumeConversation).mockImplementation(async id => ({ conversationId: id, courseId: null, sourceIds: [sourceId], currentPage: 3, boundedHistory: [], historyTruncated: false }));
  vi.mocked(api.listTurns).mockResolvedValue([]);
  function Route({ id }: { id: string }) { return <ConversationCompanionProvider><ConversationSurface api={api} initialConversationId={id} /></ConversationCompanionProvider>; }
  await act(async () => root.render(<Route id={ids[0]!} />));
  const original = host.querySelector("textarea");
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-controls="exploration-context"]')!.click());
  const page = host.querySelector<HTMLInputElement>('[aria-label="当前物理页码"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(page, "7");
    page.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="关闭上下文"]')!.click());
  for (const id of ids.slice(1)) await act(async () => root.render(<Route id={id} />));
  await act(async () => root.render(<Route id={ids[0]!} />));
  expect(host.querySelector('[data-conversation-surface] textarea')).toBe(original);
  expect(vi.mocked(api.resumeConversation).mock.calls.filter(([id]) => id === ids[0])).toHaveLength(1);
  await act(async () => host.querySelector<HTMLButtonElement>('[data-conversation-surface] [aria-controls="exploration-context"]')!.click());
  expect(host.querySelector<HTMLInputElement>('[aria-label="当前物理页码"]')?.value).toBe("7");
  expect(host.querySelector<HTMLSelectElement>('[aria-label="资料使用方式"]')?.value).toBe("selected");
  expect(api.submitTurn).not.toHaveBeenCalled(); expect(api.createConversation).not.toHaveBeenCalled();
});
