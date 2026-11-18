// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { TeachingActivity } from "@aistudy/contracts";
import { CourseRouteNextControl } from "./course-route-next-control";
import type { CourseRouteClient } from "./course-route-client";
const id = "11111111-1111-4111-8111-111111111111", courseId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", conversation = "66666666-6666-4666-8666-666666666666";
const activity = { id, courseId, routeManaged: true, status: "completed", pathVersion: 3 } as TeachingActivity;
const snapshot = { currentActivity: activity, currentRoute: { goalId: id, goalRevision: 4 }, observationId: id };
let host: HTMLDivElement, root: Root;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); sessionStorage.clear(); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
function client(): CourseRouteClient { return { read: vi.fn(async () => snapshot), confirm: vi.fn(), start: vi.fn(), next: vi.fn(async () => ({ kind: "choice", reason: "evidence_unknown", message: "本次证据不足，请选择补充作答。", courseId, href: `/opening/courses/${courseId}#course-learning-route`, requirementIds: [] })) } as unknown as CourseRouteClient; }
function button(text: string) { const node = [...host.querySelectorAll("button")].find(item => item.textContent === text); if (!node) throw new Error(`missing ${text}`); return node; }
async function render(api: CourseRouteClient, value = activity, props: { originalConversationId?: string; onNavigate?: (href: string) => void } = {}) { await act(async () => root.render(<CourseRouteNextControl activity={value} client={api} originalConversationId={props.originalConversationId} onNavigate={props.onNavigate} />)); }
it("does not make route requests for an ordinary existing activity", async () => { const api = client(); await render(api, { ...activity, routeManaged: undefined }); expect(api.read).not.toHaveBeenCalled(); expect(host.textContent).toBe(""); });
it("reads the exact origin and uses the server's route revision and effective observation", async () => { const api = client(); await render(api); expect(api.next).not.toHaveBeenCalled(); await act(async () => button("核对结果并安排下一步").click()); expect(api.read).toHaveBeenCalledWith(courseId, id); expect(api.next).toHaveBeenCalledWith(courseId, expect.objectContaining({ activityId: id, expectedPathVersion: 3, goalId: id, expectedGoalRevision: 4, observationId: id })); expect(host.textContent).toContain("本次证据不足"); });
it("keeps the original conversation when the next route returns a study URL", async () => { const api = client(); const navigate = vi.fn(); vi.mocked(api.next).mockResolvedValueOnce({ kind: "ready", activity, resumed: false, requirementId: id, action: "diagnose", href: `/opening/courses/${courseId}/study?activity=${id}#lesson` }); await render(api, activity, { originalConversationId: conversation, onNavigate: navigate }); await act(async () => button("核对结果并安排下一步").click()); expect(navigate).toHaveBeenCalledWith(`/opening/courses/${courseId}/study?activity=${id}&conversation=${conversation}#lesson`); });
it.each(["network", "timeout"])("retains the identical next command after %s and remount", async mode => { const { CourseRouteRequestError } = await import("./course-route-client"); const api = client(); vi.mocked(api.next).mockRejectedValueOnce(mode === "timeout" ? new CourseRouteRequestError("请求超时", 408) : new TypeError("lost")); await render(api); await act(async () => button("核对结果并安排下一步").click()); const original = vi.mocked(api.next).mock.calls[0]; await act(async () => root.unmount()); root = createRoot(host); await render(api); await act(async () => button("重新确认这次下一步").click()); expect(vi.mocked(api.next).mock.calls[1]).toEqual(original); expect(api.read).toHaveBeenCalledTimes(1); });
it("does not post when the exact origin has no current route context", async () => { const api = client(); vi.mocked(api.read).mockResolvedValue({ ...snapshot, currentRoute: null } as never); await render(api); await act(async () => button("核对结果并安排下一步").click()); expect(api.next).not.toHaveBeenCalled(); expect(host.textContent).toContain("路线绑定"); });
it("does not create a pending write when the origin read times out", async () => {
  const { CourseRouteRequestError } = await import("./course-route-client");
  const api = client(); vi.mocked(api.read).mockRejectedValueOnce(new CourseRouteRequestError("读取超时", 408));
  await render(api); await act(async () => button("核对结果并安排下一步").click());
  expect(api.next).not.toHaveBeenCalled(); expect(host.textContent).not.toContain("下一步结果尚未确认");
  expect(sessionStorage.getItem(`aistudy:route-next:${id}`)).toBeNull();
});
it("does not discard the unknown next intent after an authentication rejection on retry", async () => { const { CourseRouteRequestError } = await import("./course-route-client"); const api = client(); vi.mocked(api.next).mockRejectedValueOnce(new TypeError("lost")).mockRejectedValueOnce(new CourseRouteRequestError("请恢复登录", 401)); await render(api); await act(async () => button("核对结果并安排下一步").click()); const original = vi.mocked(api.next).mock.calls[0]; await act(async () => button("重新确认这次下一步").click()); expect(host.textContent).toContain("下一步结果尚未确认"); await act(async () => button("重新确认这次下一步").click()); expect(vi.mocked(api.next).mock.calls[2]).toEqual(original); });
it("offers an explicit three-day retest using the exact origin without a tutor grant", async () => { const api = client(); const scheduleRetest = vi.fn(async () => ({ courseId, taskId: id, retestId: id, notBeforeAt: "2026-10-30T00:00:00Z", taskStatus: "pending", retestStatus: "accepted", href: `/opening/courses/${courseId}/study?task=${id}` })); Object.assign(api, { scheduleRetest }); await render(api); expect(scheduleRetest).not.toHaveBeenCalled(); await act(async () => button("安排3天后复测").click()); expect(scheduleRetest).toHaveBeenCalledWith(courseId, expect.objectContaining({ goalId: id, expectedGoalRevision: 4, activityId: id, expectedPathVersion: 3, observationId: id })); expect(host.textContent).toContain("复测已安排"); expect(api.next).not.toHaveBeenCalled(); });
it("keeps the original conversation on a scheduled retest link", async () => { const api = client(); const scheduleRetest = vi.fn(async () => ({ courseId, taskId: id, retestId: id, notBeforeAt: "2026-10-30T00:00:00Z", taskStatus: "pending", retestStatus: "accepted", href: `/opening/courses/${courseId}/study?task=${id}&retest=${id}#course-practice` })); Object.assign(api, { scheduleRetest }); await render(api, activity, { originalConversationId: conversation }); await act(async () => button("安排3天后复测").click()); expect(host.querySelector("a")?.getAttribute("href")).toBe(`/opening/courses/${courseId}/study?task=${id}&retest=${id}&conversation=${conversation}#course-practice`); });
it("preserves a cancelled retest receipt without saying it has been newly arranged", async () => { const api = client(); Object.assign(api, { scheduleRetest: vi.fn(async () => ({ courseId, taskId: id, retestId: id, notBeforeAt: "2026-10-30T00:00:00Z", taskStatus: "skipped", retestStatus: "cancelled", href: `/opening/courses/${courseId}/study?task=${id}` })) }); await render(api); await act(async () => button("安排3天后复测").click()); expect(host.textContent).toContain("复测已取消"); expect(host.textContent).not.toContain("复测已安排"); });
it("does not invent a retest observation when the origin has no recorded answer", async () => { const api = client(); const scheduleRetest = vi.fn(); Object.assign(api, { scheduleRetest }); vi.mocked(api.read).mockResolvedValue({ ...snapshot, observationId: null } as never); await render(api); await act(async () => button("安排3天后复测").click()); expect(scheduleRetest).not.toHaveBeenCalled(); expect(host.textContent).toContain("真实作答"); });
it("retains an unknown retest request and replays it without reading another origin head", async () => { const api = client(); const scheduleRetest = vi.fn().mockRejectedValueOnce(new TypeError("lost")).mockResolvedValue({ courseId, taskId: id, retestId: id, notBeforeAt: "2026-10-30T00:00:00Z", taskStatus: "done", retestStatus: "completed", href: `/opening/courses/${courseId}/study?task=${id}` }); Object.assign(api, { scheduleRetest }); await render(api); await act(async () => button("安排3天后复测").click()); const original = scheduleRetest.mock.calls[0]; await act(async () => button("重新确认这次复测").click()); expect(scheduleRetest.mock.calls[1]).toEqual(original); expect(api.read).toHaveBeenCalledTimes(1); expect(host.textContent).toContain("已完成的复测记录"); });
it("does not navigate the new page when a prior next receipt resolves after leaving", async () => { const api = client(); let resolve!: (value: never) => void; vi.mocked(api.next).mockImplementationOnce(() => new Promise(done => { resolve = done; })); const navigate = vi.fn(); await act(async () => root.render(<CourseRouteNextControl activity={activity} client={api} onNavigate={navigate} />)); await act(async () => button("核对结果并安排下一步").click()); await act(async () => root.unmount()); root = createRoot(host); await act(async () => resolve({ kind: "ready", href: `/opening/courses/${courseId}/study?activity=${id}` } as never)); expect(navigate).not.toHaveBeenCalled(); });
it("exposes the real verification setup from the route action panel without loading it automatically", async () => { const api = client(); const verification = vi.fn(async () => ({ courseId, activityId: id, contentVersion: 1, requirementId: id, requirementRevision: 2, rubric: "真实判定标准", items: [], available: false, reason: "先提交真实题目。" })); Object.assign(api, { verification }); await render(api); expect(verification).not.toHaveBeenCalled(); await act(async () => button("核对已提交题目与评分标准").click()); expect(verification).toHaveBeenCalledWith(courseId, id); expect(host.textContent).toContain("先提交真实题目"); });

it.each([undefined, conversation])("keeps the original conversation %s on a next-step choice", async originalConversationId => {
  const api = client();
  await render(api, activity, { originalConversationId });
  await act(async () => button("核对结果并安排下一步").click());
  const link = [...host.querySelectorAll("a")].find(item => item.textContent === "查看并处理下一步");
  expect(link?.getAttribute("href")).toBe("/opening/courses/" + courseId + (originalConversationId ? "?conversation=" + originalConversationId : "") + "#course-learning-route");
});

it("unlocks pending next command after a 409 conflict triggers a reread with a newer version", async () => {
  const { CourseRouteRequestError } = await import("./course-route-client");
  const api = client();
  vi.mocked(api.read)
    .mockResolvedValueOnce(snapshot as never)
    .mockResolvedValueOnce({ ...snapshot, currentRoute: { goalId: id, goalRevision: 5 } } as never);
  vi.mocked(api.next)
    .mockRejectedValueOnce(new TypeError("lost"))
    .mockRejectedValueOnce(new CourseRouteRequestError("版本已更新", 409));

  await render(api);
  await act(async () => button("核对结果并安排下一步").click());
  expect(host.textContent).toContain("下一步结果尚未确认");
  expect(button("安排3天后复测").disabled).toBe(true);
  expect(sessionStorage.getItem(`aistudy:route-next:${id}`)).not.toBeNull();

  await act(async () => button("重新确认这次下一步").click());
  expect(api.read).toHaveBeenCalledTimes(2);
  expect(sessionStorage.getItem(`aistudy:route-next:${id}`)).toBeNull();
  expect(host.textContent).not.toContain("下一步结果尚未确认");
  expect(host.textContent).toContain("已不能应用");
  expect(button("核对结果并安排下一步").disabled).toBe(false);
  expect(button("安排3天后复测").disabled).toBe(false);
});

it("unlocks pending next command after a 409 reread detects a newly arrived observationId", async () => {
  const { CourseRouteRequestError } = await import("./course-route-client");
  const api = client();
  vi.mocked(api.read)
    .mockResolvedValueOnce({ ...snapshot, observationId: null } as never)
    .mockResolvedValueOnce({ ...snapshot, observationId: id } as never);
  vi.mocked(api.next)
    .mockRejectedValueOnce(new TypeError("lost"))
    .mockRejectedValueOnce(new CourseRouteRequestError("作答记录已更新", 409));

  await render(api);
  await act(async () => button("核对结果并安排下一步").click());
  expect(host.textContent).toContain("下一步结果尚未确认");
  expect(sessionStorage.getItem(`aistudy:route-next:${id}`)).not.toBeNull();

  await act(async () => button("重新确认这次下一步").click());
  expect(api.read).toHaveBeenCalledTimes(2);
  expect(sessionStorage.getItem(`aistudy:route-next:${id}`)).toBeNull();
  expect(host.textContent).not.toContain("下一步结果尚未确认");
  expect(host.textContent).toContain("已不能应用");
  expect(button("核对结果并安排下一步").disabled).toBe(false);
  expect(button("安排3天后复测").disabled).toBe(false);
});

it("unlocks pending retest command after a 409 reread detects a changed observationId", async () => {
  const { CourseRouteRequestError } = await import("./course-route-client");
  const nextObservationId = "22222222-2222-4222-8222-222222222222";
  const api = client();
  const scheduleRetest = vi.fn()
    .mockRejectedValueOnce(new TypeError("lost"))
    .mockRejectedValueOnce(new CourseRouteRequestError("作答记录已更新", 409));
  Object.assign(api, { scheduleRetest });
  vi.mocked(api.read)
    .mockResolvedValueOnce({ ...snapshot, observationId: id } as never)
    .mockResolvedValueOnce({ ...snapshot, observationId: nextObservationId } as never);

  await render(api);
  await act(async () => button("安排3天后复测").click());
  expect(host.textContent).toContain("复测安排结果尚未确认");
  expect(sessionStorage.getItem(`aistudy:route-next:${id}`)).not.toBeNull();

  await act(async () => button("重新确认这次复测").click());
  expect(api.read).toHaveBeenCalledTimes(2);
  expect(sessionStorage.getItem(`aistudy:route-next:${id}`)).toBeNull();
  expect(host.textContent).not.toContain("复测安排结果尚未确认");
  expect(host.textContent).toContain("已不能应用");
  expect(button("核对结果并安排下一步").disabled).toBe(false);
  expect(button("安排3天后复测").disabled).toBe(false);
});
