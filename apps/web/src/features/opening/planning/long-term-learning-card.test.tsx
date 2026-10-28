// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LearningManagementOverview } from "@aistudy/contracts";
import { LongTermLearningCard } from "./long-term-learning-card";
import type { LearningManagementClient } from "./learning-management-client";
vi.mock("../../auth/session-identity", () => ({ getVerifiedSessionNamespace: () => "verified-test" }));
const date = "2026-10-27", id = "11111111-1111-4111-8111-111111111111";
const overview: LearningManagementOverview = { date, timeZone: "Asia/Shanghai", budget: null, acceptedVersion: 3, acceptedBlocks: [], committedMinutes: 20, remainingMinutes: 0, overcommittedMinutes: 0, tasks: [], recovery: { kind: "none", activityId: null, taskId: null, href: null }, warnings: [], cardSessions: [], maintenanceTasks: [] };
let host: HTMLDivElement, root: Root;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); sessionStorage.clear(); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
function client(value = overview): LearningManagementClient { return { read: vi.fn(async () => value), command: vi.fn(async () => ({ overview: value, draft: null })), recover: vi.fn(), maintenance: vi.fn(), lifecycle: vi.fn(), cardSessions: vi.fn(), cardCommand: vi.fn() }; }
function button(text: string) { const node = [...host.querySelectorAll("button")].find(item => item.textContent === text); if (!node) throw new Error(`missing ${text}`); return node; }
async function render(api: LearningManagementClient) { await act(async () => root.render(<LongTermLearningCard date={date} client={api} />)); }
it("does not seed a shared budget and keeps an existing activity resumable", async () => { const api = client({ ...overview, recovery: { kind: "continue", activityId: id, taskId: null, href: `/opening/courses/${id}/study?activity=${id}` } }); await render(api); expect(host.textContent).toContain("未设置共同预算"); expect(host.querySelector('a[href*="activity="]')).toBeTruthy(); expect(api.command).not.toHaveBeenCalled(); });
it("shows the shared denominator, buffer and overcommit separately", async () => { const api = client({ ...overview, budget: { dailyMinutes: 60, bufferMinutes: 10, revision: 2, updatedAt: "2026-10-27T00:00:00Z" }, committedMinutes: 70, remainingMinutes: 0, overcommittedMinutes: 20 }); await render(api); expect(host.textContent).toContain("每日共同预算 60 分钟"); expect(host.textContent).toContain("缓冲 10 分钟"); expect(host.textContent).toContain("超出 20 分钟"); });
it("previews without accepting and only confirms the displayed draft explicitly", async () => { const value = { ...overview, budget: { dailyMinutes: 60, bufferMinutes: 10, revision: 2, updatedAt: "2026-10-27T00:00:00Z" } }; const api = client(value); vi.mocked(api.command).mockResolvedValueOnce({ overview: value, draft: { id, date, version: 4, baseVersion: 3, status: "draft", blocks: [], unscheduledTaskIds: [] } }); await render(api); await act(async () => button("预览共同安排").click()); expect(api.command).toHaveBeenCalledTimes(1); expect(host.textContent).toContain("安排草案"); await act(async () => button("确认这份安排").click()); expect(api.command).toHaveBeenLastCalledWith(expect.objectContaining({ action: "confirm", draftId: id, expectedBaseVersion: 3 })); });
it("does not clear an unknown settings CAS after reading the same old revision", async () => { const value = { ...overview, budget: { dailyMinutes: 60, bufferMinutes: 10, revision: 2, updatedAt: "2026-10-27T00:00:00Z" } }; const api = client(value); vi.mocked(api.command).mockRejectedValueOnce(new TypeError("lost")); await render(api); await act(async () => button("保存共同预算").click()); const original = vi.mocked(api.command).mock.calls[0]; await act(async () => button("重新读取长期安排").click()); expect(host.textContent).toContain("保存结果待确认"); await act(async () => button("重新确认这次操作").click()); expect(vi.mocked(api.command).mock.calls[1]).toEqual(original); });

it("starts a due maintenance task through the real route action API only on click", async () => { const api = client({ ...overview, maintenanceTasks: [{ taskId: id, goalId: id, requirementId: id, version: 3 }] }); vi.mocked(api.maintenance).mockResolvedValue({ kind: "choice", reason: "source_unavailable", message: "请补齐抽查资料。", courseId: id, href: `/opening/courses/${id}?tab=units`, requirementIds: [id] }); await render(api); expect(api.maintenance).not.toHaveBeenCalled(); await act(async () => button("开始这项保持抽查").click()); expect(api.maintenance).toHaveBeenCalledWith(expect.objectContaining({ taskId: id, expectedVersion: 3 })); expect(host.textContent).toContain("请补齐抽查资料"); });
it.each([401, 409])("keeps an unknown budget command after retry status %s", async status => {
  const { LearningManagementRequestError } = await import("./learning-management-client");
  const value = { ...overview, budget: { dailyMinutes: 60, bufferMinutes: 10, revision: 2, updatedAt: "2026-10-27T00:00:00Z" } }, api = client(value);
  vi.mocked(api.command).mockRejectedValueOnce(new TypeError("lost")).mockRejectedValueOnce(new LearningManagementRequestError("请核对当前状态", status));
  await render(api); await act(async () => button("保存共同预算").click()); const original = vi.mocked(api.command).mock.calls[0]; await act(async () => button("重新确认这次操作").click()); await act(async () => button("重新读取长期安排").click()); expect(host.textContent).toContain("保存结果待确认"); await act(async () => button("重新确认这次操作").click()); expect(vi.mocked(api.command).mock.calls[2]).toEqual(original);
});
it("offers a shorter real generic route activity rather than limiting recovery to span", async () => { const api = client({ ...overview, budget: { dailyMinutes: 60, bufferMinutes: 10, revision: 2, updatedAt: "2026-10-27T00:00:00Z" }, recovery: { kind: "continue", activityId: id, taskId: null, href: `/opening/courses/${id}/study?activity=${id}` } }); vi.mocked(api.recover).mockResolvedValue({ overview, draft: null }); await render(api); await act(async () => button("选择更短的本次活动").click()); expect(api.recover).toHaveBeenCalledWith(expect.objectContaining({ action: "shorten", activityId: id, minutes: 10 })); });

it("retains a first HTTP 408 plan preview across remount and replays the same command", async () => {
  const { LearningManagementRequestError } = await import("./learning-management-client");
  const value = { ...overview, budget: { dailyMinutes: 60, bufferMinutes: 10, revision: 2, updatedAt: "2026-10-27T00:00:00Z" } };
  const api = client(value);
  vi.mocked(api.command).mockRejectedValueOnce(new LearningManagementRequestError("request timed out", 408));
  await render(api);
  await act(async () => button("预览共同安排").click());
  const original = vi.mocked(api.command).mock.calls[0];
  expect(JSON.parse(sessionStorage.getItem(`aistudy:long-term-command:verified-test:${date}`)!)).toEqual({ kind: "command", input: original![0] });
  expect((button("预览共同安排") as HTMLButtonElement).disabled).toBe(true);
  await act(async () => root.render(null));
  await render(api);
  expect(host.textContent).toContain("保存结果待确认");
  await act(async () => button("重新确认这次操作").click());
  expect(vi.mocked(api.command).mock.calls[1]).toEqual(original);
  expect(sessionStorage.getItem(`aistudy:long-term-command:verified-test:${date}`)).toBeNull();
});

it("still clears a first definite HTTP 409 plan rejection", async () => {
  const { LearningManagementRequestError } = await import("./learning-management-client");
  const api = client(overview);
  vi.mocked(api.command).mockRejectedValueOnce(new LearningManagementRequestError("conflict", 409));
  await render(api);
  await act(async () => button("保存共同预算").click());
  expect(sessionStorage.getItem(`aistudy:long-term-command:verified-test:${date}`)).toBeNull();
  expect(host.textContent).not.toContain("保存结果待确认，这次填写的内容已保留");
});
