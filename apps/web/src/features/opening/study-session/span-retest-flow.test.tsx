// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { getSpanProblem } from "@aistudy/domain";
import type { LearningAttempt, LearningObservation, SpanLessonSnapshot } from "@aistudy/contracts";
import { createSpanStudySession } from "./adapters/span";
import { SpanLessonSession } from "../teaching/span/span-lesson-session";
import { emptyPracticeDraft, initializePracticeDraft, patchPracticeDraft, readPracticeDraft } from "../learning/practice-draft-storage";
import { spanPracticeScope } from "../teaching/span/span-practice";
const mocks = vi.hoisted(() => ({ enabled: true, createAttempt: vi.fn(), submitAttempt: vi.fn(), getAttemptContext: vi.fn(), read: vi.fn(), request: vi.fn(), hint: vi.fn() }));
vi.mock("../capabilities/capabilities-provider", () => ({ useOpeningCapabilities: () => ({ studySessionV2: mocks.enabled }) }));
vi.mock("../client/learning-client", () => ({ createOpeningLearningClient: () => mocks }));
vi.mock("../learning/practice-draft", async original => ({ ...await original<typeof import("../learning/practice-draft")>(), readPracticeRecord: mocks.read }));
vi.mock("../teaching/span/span-session-client", async original => ({ ...await original<typeof import("../teaching/span/span-session-client")>(), spanLessonRequest: mocks.request }));
vi.mock("../teaching/span/span-hint-client", async original => ({ ...await original<typeof import("../teaching/span/span-hint-client")>(), requestSpanHint: mocks.hint }));
vi.mock("../teaching/span/span-lesson", () => ({ SpanLesson: () => <p>原学习路径</p> }));
vi.mock("../teaching/span/span-session-summary", () => ({ SpanSessionSummary: () => <p>原复测小结</p> }));
const id = () => crypto.randomUUID();
function fixture() {
  const courseId = id(), sessionId = id(), sourceId = id(), retestId = id();
  const session: SpanLessonSnapshot = { activityId: id(), sessionId, courseId, sourceIds: [sourceId], retestId,
    intent: { purpose: "self_study", timeBudgetMinutes: 20, language: "zh", pace: "normal", continuous: true, selfReportedFatigue: "unknown" }, moveId: "self-example", status: "active", revision: 1, createdAt: "2026-10-31T00:00:00Z", updatedAt: "2026-10-31T00:00:00Z" };
  const attempt: LearningAttempt = { id: id(), workspaceId: id(), sessionId, courseId, sourceIds: [sourceId], sourceVersions: { [sourceId]: 1 }, skillLabel: "span", requirementKey: null, problemId: id(), itemVersionId: id(), startedAt: session.createdAt, submittedAt: null, observationId: null, historyRevision: 0,
    spanExercise: { ...getSpanProblem("span-independent-3d")!, id: "span-reserved-generated-retest-independent-2d-1729-0" } };
  const details = { session, attempts: [] as LearningAttempt[], observations: [], assistance: {}, hintLevels: {}, intentEvent: null };
  return { session, attempt, details };
}
afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear(); mocks.enabled = true; });
it.each([false, true])("routes due retest with v2=%s, submits its canonical identity and resumes the original task", async enabled => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); mocks.enabled = enabled;
  const { session, attempt, details } = fixture();
  const routeAlias = id(); // The service has already resolved the route reference to session.retestId.
  const record = { id: id(), assistance: "hinted", serverEvaluation: { decision: "correct", reasonCodes: ["verified_exactly"] } } as LearningObservation;
  let created = false, saved = false;
  mocks.read.mockImplementation(async () => ({ observation: saved ? record : null, deliveredAssistance: "hinted" }));
  mocks.getAttemptContext.mockResolvedValue({ attempt });
  mocks.request.mockImplementation(async (path: string, _schema: unknown, init?: RequestInit) => {
    if (path.includes("/lesson") && init?.method === "POST") { created = true; return session; }
    if (path.includes("/lesson") && init?.method === "PATCH") return { ...session, ...JSON.parse(String(init.body)), revision: 2 };
    if (path.includes("/lesson")) return { ...details, session: created ? session : null };
    if (path.endsWith("/reserved")) return attempt;
    if (path.endsWith("/next")) return { kind: "choice", reason: "unknown_evidence", primary: { href: `/opening/courses/${session.courseId}#course-learning-records`, label: "查看本次真实记录" } };
    return {};
  });
  mocks.submitAttempt.mockImplementationOnce(async () => { throw new Error("network unknown"); }).mockImplementation(async () => { saved = true; return record; });
  const host = document.createElement("div"), root = createRoot(host);
  const props = { courseId: session.courseId, sourceIds: session.sourceIds, sourceLoadError: false, delayedRetestId: routeAlias };
  const click = async (text: string) => { const button = [...host.querySelectorAll("button")].find(node => node.textContent === text); expect(button).toBeDefined(); await act(async () => button!.click()); };
  try {
    await act(async () => root.render(<SpanLessonSession {...props} />));
    const create = mocks.request.mock.calls.find(call => call[0].endsWith("/lesson") && call[2]?.method === "POST");
    expect(JSON.parse(String(create![2].body))).toMatchObject({ retestId: routeAlias });
    if (!enabled) { expect(host.textContent).toContain("原学习路径"); expect(mocks.submitAttempt).not.toHaveBeenCalled(); return; }
    expect(host.textContent).toContain("延迟复测");
    expect(host.textContent).not.toMatch(/需要帮助|先给一点提示|分钟/);
    expect(host.querySelectorAll("[data-primary-action]")).toHaveLength(1);
    expect(host.querySelector("[data-primary-action]")?.textContent).toBe("提交答案");
    expect(mocks.hint).not.toHaveBeenCalled(); expect(mocks.createAttempt).not.toHaveBeenCalled();
    const plan = mocks.request.mock.calls.find(call => call[0].endsWith("/session"));
    expect(JSON.parse(String(plan![2].body))).toMatchObject({ sessionId: session.sessionId, retestId: session.retestId });
    const select = host.querySelector("select")!;
    await act(async () => { select.value = "in_span"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await click("提交答案"); expect(host.textContent).toContain("network unknown");
    const sealed = mocks.submitAttempt.mock.calls[0]!;
    expect(sealed[0]).toBe(attempt.id); expect(sealed[1]).toMatchObject({ retestId: session.retestId, assistance: "hinted" });
    expect(JSON.parse(sealed[1].answer).membership).toBe("in_span");
    await click("重新读取");
    expect(mocks.getAttemptContext).toHaveBeenCalledWith(attempt.id);
    expect(host.textContent).not.toContain("需要帮助"); expect(mocks.hint).not.toHaveBeenCalled();
    await click("确认已提交的答案");
    expect(mocks.submitAttempt.mock.calls[1]).toEqual(sealed);
    expect(host.textContent).toContain("用提示后答对");
    await click("安排下一步学习"); expect(host.textContent).toContain("查看本次真实记录");
    await click("暂停并保存"); expect(host.textContent).toContain("本次学习已暂停");
    await click("继续原来的步骤"); expect(host.textContent).toContain("用提示后答对");
    expect(mocks.request.mock.calls.filter(call => call[0].endsWith("/reserved"))).toHaveLength(1);
    expect(mocks.request.mock.calls.some(call => call[0].endsWith("/presentation"))).toBe(false);
  } finally { await act(async () => root.unmount()); }
});
it("recovers the server's original reserved attempt without issuing another question", async () => {
  const { session, attempt, details } = fixture();
  mocks.read.mockResolvedValue({ observation: null, deliveredAssistance: "none" });
  const port = createSpanStudySession({ ...details, attempts: [attempt] }, vi.fn());
  expect((await port.load()).step).toMatchObject({ kind: "question", purpose: "retest", attemptRef: { id: attempt.id } });
  expect(mocks.request).not.toHaveBeenCalled(); expect(mocks.createAttempt).not.toHaveBeenCalled();
  const scope = spanPracticeScope(session.courseId, session.retestId!, undefined, session.activityId, "reserved:auto");
  expect(readPracticeDraft(scope, sessionStorage)).toMatchObject({ attemptId: attempt.id, start: { sessionId: session.sessionId } });
});
it("restores the legacy retest owner/draft, preserves delivered help, and isolates ordinary and other retest scopes", async () => {
  const { session, attempt, details } = fixture();
  const scope = spanPracticeScope(session.courseId, session.retestId!, undefined, session.activityId, "reserved:auto");
  const ordinary = spanPracticeScope(session.courseId, undefined, undefined, session.activityId, "reserved:auto");
  const other = spanPracticeScope(session.courseId, id(), undefined, session.activityId, "reserved:auto");
  initializePracticeDraft(emptyPracticeDraft(ordinary, { answer: "ordinary" }));
  initializePracticeDraft(emptyPracticeDraft(other, { answer: "other retest" }));
  initializePracticeDraft(emptyPracticeDraft(scope, { sourceId: session.sourceIds[0], spanProblemId: attempt.spanExercise!.id, skillLabel: "线性组合与 span", assistance: "revealed", deliveredAssistance: "revealed" }));
  const key = `span-restored:${attempt.id}`;
  patchPracticeDraft(scope, {}, { attemptId: attempt.id, start: { clientKey: key, sessionId: session.sessionId, sessionInput: { courseId: session.courseId, activityId: session.activityId, sourceIds: session.sourceIds, skillLabel: "线性组合与 span" }, createInput: { sessionId: session.sessionId, clientKey: key, spanExercise: { sourceId: session.sourceIds[0]!, problemId: attempt.spanExercise!.id, version: 1 } } } }, sessionStorage);
  mocks.getAttemptContext.mockResolvedValue({ attempt }); mocks.read.mockResolvedValue({ observation: null, deliveredAssistance: "none" });
  const port = createSpanStudySession({ ...details, hintLevels: { [attempt.id]: [1, 4] } }, vi.fn());
  expect(await port.load()).toMatchObject({ step: { kind: "question", purpose: "retest", attemptRef: { id: attempt.id } }, help: { level: "revealed", canRequest: false, texts: [] } });
  await port.help(); expect(mocks.hint).not.toHaveBeenCalled(); expect(mocks.request).not.toHaveBeenCalled();
  port.edit("membership", "in_span"); mocks.submitAttempt.mockRejectedValue(new Error("unknown"));
  await expect(port.primary()).rejects.toThrow("unknown");
  expect(mocks.submitAttempt.mock.calls[0]![1]).toMatchObject({ retestId: session.retestId, assistance: "revealed" });
  expect(readPracticeDraft(ordinary, sessionStorage)?.fields.answer).toBe("ordinary");
  expect(readPracticeDraft(other, sessionStorage)?.fields.answer).toBe("other retest");
  const restored = createSpanStudySession(details, vi.fn()); await restored.load();
  await expect(restored.primary()).rejects.toThrow("unknown");
  expect(mocks.submitAttempt.mock.calls[1]).toEqual(mocks.submitAttempt.mock.calls[0]);
});
