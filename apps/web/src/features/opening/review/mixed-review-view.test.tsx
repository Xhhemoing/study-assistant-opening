// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReviewQueueItem, TaskItem } from "@aistudy/contracts";
import type { OpeningCardsClient } from "../cards/cards-client";
import { publishVerifiedSessionIdentity } from "../../auth/session-identity";

vi.mock("../cards/card-review-view", () => ({ CardReviewView: ({ onGraded, onBusyChange }: { onGraded: (id: string) => void; onBusyChange: (busy: boolean) => void }) => createElement("button", { onClick: () => { onBusyChange(true); onGraded("11111111-1111-4111-8111-000000000001"); onBusyChange(false); } }, "保存卡片评分") }));
import { MixedReviewView } from "./mixed-review-view";

const cardId = "11111111-1111-4111-8111-000000000001";
const taskId = "11111111-1111-4111-8111-000000000002";
const task: TaskItem = { id: taskId, courseId: taskId, title: "独立复测", minutes: 5, dueAt: null, priority: 1, status: "pending", suggestionKind: "weak_skill" };
let root: Root, container: HTMLDivElement, clearIdentity: () => void;
let listCards: ReturnType<typeof vi.fn<() => Promise<ReviewQueueItem[]>>>;
let listTasks: ReturnType<typeof vi.fn<() => Promise<{ tasks: TaskItem[] }>>>;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  clearIdentity = publishVerifiedSessionIdentity({ id: "owner", workspaceId: "workspace" });
  listCards = vi.fn<() => Promise<ReviewQueueItem[]>>().mockResolvedValue([{ card: { id: cardId } } as ReviewQueueItem]);
  listTasks = vi.fn<() => Promise<{ tasks: TaskItem[] }>>().mockResolvedValue({ tasks: [task] });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); clearIdentity(); container.remove(); vi.restoreAllMocks(); });
async function render() {
  await act(async () => root.render(createElement(MixedReviewView, { cardsClient: { listDue: listCards } as unknown as OpeningCardsClient, taskClient: { listTasks } })));
}
const button = (text: string) => Array.from(container.querySelectorAll("button")).find(item => item.textContent === text)!;

it("advances from a confirmed card to the actual task, and returning does not complete a pending task", async () => {
  await render();
  expect(container.textContent).toContain("本轮 2 项");
  expect(container.textContent).toContain("保存卡片评分");
  listCards.mockResolvedValue([]);
  await act(async () => button("保存卡片评分").click());
  const link = container.querySelector<HTMLAnchorElement>('a[target="_blank"]')!;
  expect(link.getAttribute("href")).toBe(`/opening/courses/${taskId}/study?task=${taskId}`);
  expect(link.rel).toBe("noopener noreferrer");
  expect(container.textContent).toContain("打开练习（新标签）");
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(container.textContent).toContain("独立复测");
  expect(container.textContent).toContain("已完成任务 0 项");
  listTasks.mockResolvedValue({ tasks: [{ ...task, status: "done" }] });
  await act(async () => button("核对最新进度").click());
  expect(container.textContent).toContain("已完成任务 1 项");
  expect(container.textContent).toContain("本轮当前没有可继续的项目");
});

it("restores the locally skipped navigation on remount without changing a task", async () => {
  listCards.mockResolvedValue([]);
  await render();
  await act(async () => button("本轮先略过这一项").click());
  expect(container.textContent).toContain("本轮略过 1 项");
  await act(async () => root.unmount()); root = createRoot(container);
  await render();
  expect(container.textContent).toContain("本轮略过 1 项");
  expect(container.textContent).not.toContain("已完成任务 1 项");
  expect(task.status).toBe("pending");
  await act(async () => button("重新安排本轮").click());
  expect(container.textContent).toContain("独立复测");
});

it("keeps source failures explicit instead of calling the round complete", async () => {
  listTasks.mockRejectedValue(new Error("任务读取失败"));
  await render();
  expect(container.textContent).toContain("无法核对完整队列");
  expect(container.textContent).not.toContain("本轮当前没有可继续的项目");
  expect(localStorage.length).toBe(0);
});

it("does not silently replace unreadable persisted navigation", async () => {
  localStorage.setItem('aistudy.review-session.v1:["owner","workspace"]', "{");
  await render();
  expect(container.textContent).toContain("本轮进度暂时无法读取");
  expect(container.textContent).not.toContain("保存卡片评分");
  expect(localStorage.getItem('aistudy.review-session.v1:["owner","workspace"]')).toBe("{");
  await act(async () => button("重新安排本轮").click());
  expect(container.textContent).toContain("保存卡片评分");
});
