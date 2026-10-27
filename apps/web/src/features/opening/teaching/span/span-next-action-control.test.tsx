// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { LearningObservation } from "@aistudy/contracts";
vi.mock("../../v3/motion/view-transition", () => ({ TransitionLink: "a" }));
import { SpanNextActionControl, currentSpanObservationId } from "./span-next-action-control";
beforeAll(async () => { await import("./span-lesson"); }, 30_000);
const id = "11111111-1111-4111-8111-111111111111", nextId = "22222222-2222-4222-8222-222222222222", courseId = "33333333-3333-4333-8333-333333333333";
const session = { activityId: id, sessionId: id, courseId, revision: 3 };
const href = `/opening/courses/${courseId}/study/span?lesson=${nextId}`;
const ready = { kind: "ready", href, activityId: nextId, sessionId: nextId, courseId, label: "开始下一道新题", resumed: false };
let host: HTMLDivElement, root: Root;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("fetch", vi.fn(async () => Response.json(ready))); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
function button(text: string) { const node = [...host.querySelectorAll("button")].find(item => item.textContent === text); if (!node) throw new Error(`missing ${text}`); return node; }
async function render(observationId: string | null = id) { const navigate = vi.fn(), reload = vi.fn(); await act(async () => root.render(<SpanNextActionControl session={session} observationId={observationId} onNavigate={navigate} onReload={reload} />)); return { navigate, reload }; }
it("selects and opens a real next activity only after the learner's explicit action", async () => {
  const { navigate } = await render();
  expect(fetch).not.toHaveBeenCalled();
  await act(async () => button("安排下一步学习").click());
  const [path, init] = vi.mocked(fetch).mock.calls[0]!;
  expect(path).toBe("/api/opening/teaching/span/next");
  expect(JSON.parse(String(init?.body))).toEqual({ activityId: id, expectedRevision: 3, observationId: id, clientKey: `span-next:${id}:3:${id}` });
  expect(navigate).toHaveBeenCalledExactlyOnceWith(href);
  expect(host.textContent).toContain("开始下一道新题");
});
it("retains the original key, revision and observation after an unknown save even if new props arrive", async () => {
  vi.mocked(fetch).mockRejectedValueOnce(new Error("connection lost")).mockResolvedValueOnce(Response.json(ready));
  const { navigate, reload } = await render();
  await act(async () => button("安排下一步学习").click());
  expect(host.textContent).toContain("结果尚未确认");
  await act(async () => root.render(<SpanNextActionControl session={{ ...session, revision: 4 }} observationId={nextId} onNavigate={navigate} onReload={reload} />));
  await act(async () => button("重新确认这次安排").click());
  expect(vi.mocked(fetch).mock.calls[1]).toEqual(vi.mocked(fetch).mock.calls[0]);
  expect(navigate).toHaveBeenCalledExactlyOnceWith(href);
});
it("shows an actionable choice for unavailable evidence without pretending to create an activity", async () => {
  vi.mocked(fetch).mockResolvedValue(Response.json({ kind: "choice", reason: "unknown_evidence", message: "当前证据不足，可以先独立练习。", primary: { label: "核对学习记录", href: `/opening/courses/${courseId}#course-learning-records` }, secondary: { label: "返回课程学习", href: `/opening/courses/${courseId}/study` } }));
  const { navigate } = await render(null);
  await act(async () => button("安排下一步学习").click());
  expect(host.textContent).toContain("当前证据不足");
  expect(host.querySelector('a[href$="#course-learning-records"]')?.textContent).toBe("核对学习记录");
  expect(navigate).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledTimes(1);
});
it.each(["https://example.com/", `//opening.local/opening/courses/${courseId}/study/span?lesson=${nextId}`, `/opening/courses/${id}/study/span?lesson=${nextId}`])("rejects a ready destination outside the confirmed course (%s)", async target => {
  vi.mocked(fetch).mockResolvedValue(Response.json({ ...ready, href: target }));
  const { navigate } = await render();
  await act(async () => button("安排下一步学习").click());
  expect(navigate).not.toHaveBeenCalled();
  expect(host.textContent).toContain("结果尚未确认");
});
it("requires rereading after a definite stale-origin rejection instead of silently submitting a new head", async () => {
  vi.mocked(fetch).mockResolvedValue(Response.json({ error: { message: "学习记录已变化，请重新读取。" } }, { status: 409 }));
  const { reload } = await render();
  await act(async () => button("安排下一步学习").click());
  expect(host.textContent).toContain("学习记录已变化");
  expect((button("安排下一步学习") as HTMLButtonElement).disabled).toBe(true);
  await act(async () => button("重新读取本节").click());
  expect(reload).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("uses the newest submitted effective row in this origin instead of a later correction of an older answer", () => {
  const row = { id, courseId, sessionId: id, occurredAt: "2026-10-27T10:00:00Z", submittedAt: "2026-10-27T10:00:00Z", recordedAt: "2026-10-27T13:00:00Z" } as LearningObservation;
  const current = { ...row, id: nextId, submittedAt: "2026-10-27T11:00:00Z", recordedAt: "2026-10-27T11:01:00Z" };
  expect(currentSpanObservationId([row, current, { ...row, id: courseId, effectiveHeadId: nextId }, { ...current, id: courseId, revisionKind: "retract" }, { ...current, id: courseId, sessionId: nextId }], session)).toBe(nextId);
});

it("offers a real next action for a failed delayed retest without returning that retest to an example step", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { SpanLesson } = await import("./span-lesson");
  const record = { id, attemptId: id, sessionId: id, courseId, answer: "answer", occurredAt: "2026-10-27T10:00:00Z", serverEvaluation: { evaluatorVersion: "span-exact-v1", decision: "incorrect" } } as LearningObservation;
  const html = renderToStaticMarkup(<SpanLesson courseId={courseId} sourceIds={[]} sourceLoadError delayedRetestId={nextId}
    session={{ ...session, sourceIds: [], intent: { purpose: "self_study", timeBudgetMinutes: 20, language: "zh", pace: "normal", continuous: true, selfReportedFatigue: "unknown" }, moveId: "self_study-reserved", status: "active", retestId: nextId, createdAt: record.occurredAt, updatedAt: record.occurredAt }}
    restoredAttempts={[{ id, spanExercise: { id: "span-reserved-test" } } as never]} restoredObservations={[record]} />);
  expect(html).toContain("安排下一步学习");
  expect(html).not.toContain("回看关系与示范");
});

it("does not submit the stale restored row after a locally received replacement", () => {
  const original = { id: nextId, sessionId: id, courseId, submittedAt: "2026-10-27T10:00:00Z", occurredAt: "2026-10-27T10:00:00Z" } as LearningObservation;
  const replacement = { ...original, id, rootObservationId: nextId, revisesObservationId: nextId, revisionKind: "replace" as const };
  expect(currentSpanObservationId([original, replacement], session)).toBe(id);
});

it("keeps an expired retest as history with a real course-records choice", async () => {
  vi.mocked(fetch).mockResolvedValue(Response.json({ kind: "choice", reason: "expired", message: "这项复测已过期，原记录保留。", primary: { label: "查看原记录", href: `/opening/courses/${courseId}#course-learning-records` } }));
  const { navigate } = await render();
  await act(async () => button("安排下一步学习").click());
  expect(host.textContent).toContain("这项复测已过期");
  expect(host.querySelector('a[href$="#course-learning-records"]')?.textContent).toBe("查看原记录");
  expect(navigate).not.toHaveBeenCalled();
});

it("permits a new explicit check after course authorization without changing the origin request", async () => {
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ kind: "choice", reason: "authorization_required", message: "请先确认本课程导师授权。", primary: { label: "保留本节并确认授权", href: `/opening/courses/${courseId}/study/span?lesson=${id}` } })).mockResolvedValueOnce(Response.json(ready));
  const { navigate } = await render();
  await act(async () => button("安排下一步学习").click());
  expect(fetch).toHaveBeenCalledTimes(1);
  await act(async () => button("授权后重新核对下一步").click());
  expect(vi.mocked(fetch).mock.calls[1]).toEqual(vi.mocked(fetch).mock.calls[0]);
  expect(navigate).toHaveBeenCalledExactlyOnceWith(href);
});

it("opens the real ordinary-practice fallback while keeping it separate from unseen validation", async () => {
  const practiceHref = `/opening/courses/${courseId}/study?${new URLSearchParams({ mode: "practice", skillLabel: "线性组合与张成", requirementKey: "span:linear-combination:v1" })}`;
  vi.mocked(fetch).mockResolvedValue(Response.json({ kind: "choice", reason: "unseen_unavailable", message: "当前未见题已用完，普通练习仍可继续。", primary: { label: "继续普通练习（不作为未见题验证）", href: practiceHref } }));
  const { navigate } = await render();
  await act(async () => button("安排下一步学习").click());
  expect(host.querySelector<HTMLAnchorElement>('a[href*="mode=practice"]')?.getAttribute("href")).toBe(practiceHref);
  expect(host.textContent).toContain("不作为未见题验证");
  expect(navigate).not.toHaveBeenCalled();
});

it("shows a changed-evidence choice without reviving the superseded lesson", async () => {
  vi.mocked(fetch).mockResolvedValue(Response.json({ kind: "choice", reason: "evidence_changed", message: "原评价已变化，请重新选择。", primary: { label: "核对原记录", href: `/opening/courses/${courseId}#course-learning-records` } }));
  const { navigate } = await render();
  await act(async () => button("安排下一步学习").click());
  expect(host.textContent).toContain("原评价已变化");
  expect(host.querySelector('a[href$="#course-learning-records"]')?.textContent).toBe("核对原记录");
  expect(navigate).not.toHaveBeenCalled();
});
