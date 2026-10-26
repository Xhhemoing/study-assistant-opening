// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { StudyContextAnchor, TurnRecord } from "@aistudy/contracts";
import type { AssistantEntry } from "./assistant-entry";

const api = vi.hoisted(() => ({ listConversations: vi.fn(), listTurns: vi.fn() }));
const reports = vi.hoisted(() => new Map<string, ((id: string | null) => void) | undefined>());
vi.mock("../client/api", () => ({ createOpeningApi: () => api }));
vi.mock("./assistant-view", () => ({ AssistantView: () => <p data-ordinary>普通对话</p> }));
vi.mock("./assistant-session", () => ({ AssistantSession: ({ entry, agent, onConversationChange }: { entry: AssistantEntry; agent?: boolean; onConversationChange?: (id: string | null) => void }) => {
  reports.set(entry.conversation ?? "new", onConversationChange);
  return <p data-session data-conversation={entry.conversation} data-attempt={entry.context?.attemptId} data-agent={agent}>本题对话</p>;
} }));
import { AgentWorkspace } from "./agent-workspace";

const idA = "11111111-1111-4111-8111-111111111111", idB = "22222222-2222-4222-8222-222222222222";
const at = "2026-10-25T15:00:00.000Z";
const anchor = (id: string): StudyContextAnchor => ({ courseId: id, activityId: id, attemptId: id, itemVersionId: id, purpose: "learning_help" });
const turns = (id: string): TurnRecord[] => [{ id, conversationId: id, role: "user", text: "为什么", mode: "hint", status: "complete", citations: [], createdAt: at, contextAnchor: anchor(id) }];
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks(); reports.clear();
  api.listConversations.mockResolvedValue([{ id: idA, title: "题目A", courseId: idA, updatedAt: at, lastTurnPreview: null }, { id: idB, title: "题目B", courseId: idB, updatedAt: at, lastTurnPreview: null }]);
  api.listTurns.mockImplementation(async id => turns(id));
  window.history.replaceState({}, "", `/opening/agent?conversation=${idA}&attemptId=${idA}&courseId=${idA}`);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });
const button = (label: string) => Array.from(host.querySelectorAll("button")).find(row => row.textContent?.trim() === label);

it("restores the same strict conversation from owned turns even when the URL has no context", async () => {
  await act(async () => root.render(<AgentWorkspace initialConversationId={idA} />));
  expect(host.querySelector("[data-session]")?.getAttribute("data-conversation")).toBe(idA);
  expect(host.querySelector("[data-session]")?.getAttribute("data-attempt")).toBe(idA);
  expect(host.querySelector("[data-session]")?.getAttribute("data-agent")).toBe("true");
  expect(host.querySelector("[data-ordinary]")).toBeNull();
});

it("blocks a conflicting requested question instead of opening an ordinary sendable conversation", async () => {
  await act(async () => root.render(<AgentWorkspace initialConversationId={idA} initialContext={{ attemptId: idB }} />));
  expect(host.querySelector("[data-session]")).toBeNull();
  expect(host.querySelector("[data-ordinary]")).toBeNull();
  expect(host.textContent).toContain("不一致");
});

it("blocks failed context reads until a successful explicit reread", async () => {
  api.listTurns.mockRejectedValueOnce(new Error("历史暂不可读"));
  await act(async () => root.render(<AgentWorkspace initialConversationId={idA} />));
  expect(host.querySelector("[data-ordinary]")).toBeNull();
  expect(host.querySelector("[data-session]")).toBeNull();
  expect(host.textContent).toContain("历史暂不可读");
  await act(async () => button("重新读取")!.click());
  expect(host.querySelector("[data-session]")?.getAttribute("data-attempt")).toBe(idA);
});

it("isolates a late context read after switching questions and clears the old context query", async () => {
  let finishA!: (value: TurnRecord[]) => void;
  api.listTurns.mockImplementationOnce(() => new Promise(resolve => { finishA = resolve; }));
  await act(async () => root.render(<AgentWorkspace initialConversationId={idA} initialContext={{ attemptId: idA }} />));
  expect(host.querySelector("[data-session]")).toBeNull();
  await act(async () => button("题目B")!.click());
  expect(host.querySelector("[data-session]")?.getAttribute("data-attempt")).toBe(idB);
  expect(new URLSearchParams(window.location.search).has("attemptId")).toBe(false);
  await act(async () => finishA(turns(idA)));
  expect(host.querySelector("[data-session]")?.getAttribute("data-attempt")).toBe(idB);
  expect(new URLSearchParams(window.location.search).get("conversation")).toBe(idB);
});

it("ignores a departed session identity callback and starts a clean new conversation", async () => {
  await act(async () => root.render(<AgentWorkspace initialConversationId={idA} initialContext={{ attemptId: idA }} />));
  const lateA = reports.get(idA);
  await act(async () => button("题目B")!.click());
  await act(async () => lateA?.(idA));
  expect(new URLSearchParams(window.location.search).get("conversation")).toBe(idB);
  await act(async () => button("新对话")!.click());
  expect(window.location.search).toBe("");
  expect(host.querySelector("[data-session]")).toBeNull();
  expect(host.querySelector("[data-ordinary]")).not.toBeNull();
});
