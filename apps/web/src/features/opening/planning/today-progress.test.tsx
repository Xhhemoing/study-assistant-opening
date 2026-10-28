// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { OpeningApi } from "../client/api";
const mocks = vi.hoisted(() => ({ listDue: vi.fn() }));
vi.mock("../cards/cards-client", () => ({ createOpeningCardsClient: () => ({ listDue: mocks.listDue }) }));
import { TodayProgress } from "./today-progress";

const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); });
const base = { minutes: 20, priority: 1, dueAt: null, title: "练习", courseId: "course" };
const tasks = [
  { ...base, id: "done", status: "done" }, { ...base, id: "skipped", status: "skipped" },
  { ...base, id: "review", status: "pending", suggestionKind: "weak_skill" },
  { ...base, id: "later", status: "pending", suggestionKind: "weak_skill", notBefore: "2099-01-01T00:00:00Z" },
];
const api = () => ({ listTasks: vi.fn(async () => ({ tasks })), getToday: vi.fn(async () => ({ acceptedVersion: 1, blocks: ["done", "skipped", "review"].map(taskId => ({ taskId, start: "2026-10-21T10:00:00Z", end: "2026-10-21T10:20:00Z" })) })) });
async function render(client: unknown) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host); roots.push(root);
  await act(async () => root.render(<TodayProgress api={client as unknown as OpeningApi} timeZone="America/Los_Angeles" reloadToken={0} />));
  return host;
}
it("counts confirmed completion and due review only, without treating skipped work or scheduled time as learning", async () => {
  mocks.listDue.mockResolvedValue([{}, {}]);
  const host = await render(api());
  expect(host.textContent).toContain("1/3 项");
  expect(host.querySelector('a[href="/opening/review"]')?.textContent).toBe("复习 · 3 项");
  expect(host.querySelector("h2")?.parentElement?.textContent).not.toContain("分钟");
  expect(host.querySelector("progress")?.value).toBe(1);
});
it("keeps a failed source unknown and lets the learner retry without displaying false zero counts", async () => {
  mocks.listDue.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce([]);
  const host = await render(api());
  expect(host.querySelector('a[href="/opening/review"]')?.textContent).toBe("复习");
  expect(host.textContent).toContain("1/3 项");
  await act(async () => host.querySelector("button")!.click());
  expect(host.querySelector('a[href="/opening/review"]')?.textContent).toBe("复习 · 1 项");
});

it("shows real due work without timetable settings while preserving future and finished states", async () => {
  mocks.listDue.mockResolvedValue([]);
  const now = new Date();
  const earlier = new Date(now.getTime() - 60_000).toISOString();
  const later = new Date(now.getTime() + 86_400_000).toISOString();
  const retest = { candidateId: "candidate", activityId: "activity", courseId: "course", skillLabel: "span", prompt: "retry", recommendedAt: earlier };
  const client = {
    listTasks: vi.fn(async () => ({ tasks: [
      { ...base, id: "due", title: "向量张成补测", status: "pending", version: 2, retest },
      { ...base, id: "ordinary", title: "阅读矩阵笔记", status: "pending", version: 1 },
      { ...base, id: "future", title: "未来补测", status: "pending", retest: { ...retest, recommendedAt: later } },
      { ...base, id: "deferred", title: "明天再读", status: "pending", notBefore: later },
      { ...base, id: "done", title: "已经完成", status: "done" },
      { ...base, id: "skipped", title: "已经跳过", status: "skipped" },
    ] })),
    getToday: vi.fn(async () => ({ date: "2026-10-27", acceptedVersion: 0, blocks: [], hardBlocks: [], dailyDraft: null, dailyDraftSkippedReason: "no_settings" })),
    putPlanningSettings: vi.fn(), createTask: vi.fn(), updateTaskStatus: vi.fn(),
  };
  const host = await render(client as unknown as OpeningApi);
  expect(host.textContent).toContain("向量张成补测");
  expect(host.textContent).toContain("阅读矩阵笔记");
  expect(host.textContent).toContain("到期补测");
  expect(host.querySelector('a[href="/opening/courses/course/study?task=due"]')?.textContent).toContain("补测");
  for (const title of ["未来补测", "明天再读", "已经完成", "已经跳过"]) expect(host.textContent).not.toContain(title);
  expect(client.putPlanningSettings).not.toHaveBeenCalled();
  expect(client.createTask).not.toHaveBeenCalled();
  expect(client.updateTaskStatus).not.toHaveBeenCalled();
});

it("keeps due tasks visible when calendar or card reads fail", async () => {
  mocks.listDue.mockRejectedValue(new Error("cards offline"));
  const client = api();
  client.getToday.mockRejectedValue(new Error("calendar offline"));
  const host = await render(client as unknown as OpeningApi);
  expect(host.querySelector('[aria-label="今日待办"]')?.textContent).toContain("练习");
  expect(host.textContent).toContain("部分进度还没加载好");
  expect(host.querySelector("progress")).toBeNull();
});

it("uses the displayed task version and rereads after an explicit completion", async () => {
  mocks.listDue.mockResolvedValue([]);
  const pending = { ...base, id: "task", title: "待完成的练习", status: "pending" as const, version: 7 };
  const completed = { ...pending, status: "done" as const, version: 8 };
  const client = {
    listTasks: vi.fn().mockResolvedValueOnce({ tasks: [pending] }).mockResolvedValue({ tasks: [completed] }),
    getToday: vi.fn(async () => ({ date: "2026-10-27", acceptedVersion: 0, blocks: [], hardBlocks: [], dailyDraftSkippedReason: "no_settings" })),
    updateTaskStatus: vi.fn(async () => completed),
  };
  const host = await render(client as unknown as OpeningApi);
  const complete = [...host.querySelectorAll("button")].find(button => button.textContent === "标记完成")!;
  expect(complete).not.toBeUndefined();
  await act(async () => complete.click());
  expect(client.updateTaskStatus).toHaveBeenCalledExactlyOnceWith("task", { status: "done", expectedVersion: 7, at: expect.any(String) });
  expect(client.listTasks).toHaveBeenCalledTimes(2);
  expect(host.textContent).not.toContain("待完成的练习");
});

it("does not route a mismatched retest into another course", async () => {
  mocks.listDue.mockResolvedValue([]);
  const client = {
    listTasks: vi.fn(async () => ({ tasks: [{ ...base, id: "mismatch", title: "需核对的补测", status: "pending", retest: { courseId: "other-course", recommendedAt: null } }] })),
    getToday: vi.fn(async () => ({ date: "2026-10-27", acceptedVersion: 0, blocks: [], hardBlocks: [], dailyDraftSkippedReason: "no_settings" })),
  };
  const host = await render(client as unknown as OpeningApi);
  expect(host.textContent).toContain("需核对的补测");
  expect(host.textContent).toContain("补测关联暂时不可用");
  expect(host.querySelector('a[href*="task=mismatch"]')).toBeNull();
});
