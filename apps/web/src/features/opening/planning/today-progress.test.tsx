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
async function render(client: ReturnType<typeof api>) {
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
  expect(host.textContent).not.toContain("分钟");
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
