// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { getSpanProblem } from "@aistudy/domain";
import type { LearningAttempt, LearningObservation, SpanLessonSnapshot } from "@aistudy/contracts";
import type { Sql } from "postgres";
import { createSpanSessionService } from "../teaching/span/session-service";
import { createSpanLessonSessionService } from "../teaching/span/lesson-session-service";
const serviceIO = vi.hoisted(() => ({ get: vi.fn(), matchesRetestReference: vi.fn(), listByActivity: vi.fn(), decision: vi.fn() }));
vi.mock("@aistudy/database", async original => ({ ...await original<typeof import("@aistudy/database")>(),
  lockWorkspaceLearningHistory: async () => {}, readOpeningLearningDecisionByClientKey: async () => null,
  appendOpeningStudyIntentInTx: async () => ({ id: "intent", version: 1 }),
  readOpeningLearnerState: async () => ({ stateVersion: "1", sourceVersions: {}, dataAsOf: "2026-10-31T00:00:00Z" }),
  recordOpeningLearningDecision: serviceIO.decision,
  createOpeningSpanSessionRepository: () => ({ get: serviceIO.get, matchesRetestReference: serviceIO.matchesRetestReference, deliveredHintLevels: async () => ({}) }),
  createOpeningLearningAttemptRepository: () => ({ listByActivity: serviceIO.listByActivity }),
  readOpeningCourseObservationHeads: async () => [], createOpeningStudyIntentRepository: () => ({ latest: async () => null }),
  readOpeningSpanTutorOriginChange: async () => undefined,
  createOpeningLearningDecisionsRepository: () => ({ list: async () => [] }),
  createOpeningLearningRepository: () => ({ listDeliveredExposures: async () => [] }),
  createOpeningLearningAgendaRepository: () => ({ get: async () => null }),
}));
vi.mock("../planning/plan-service", () => ({ createOpeningPlanService: () => ({ listTasks: async () => [] }) }));
function prepareFor(session: SpanLessonSnapshot) {
  const scope = { workspaceId: id(), ownerUserId: id() };
  const tx = Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?");
    expect(values).toContain(scope.workspaceId); expect(values).toContain(scope.ownerUserId);
    if (query.includes("SELECT id,activity_id,course_id")) return values.includes(session.sessionId) ? [{ id: session.sessionId, activity_id: session.activityId, course_id: session.courseId }] : [];
    if (query.includes("SELECT not_before_at")) return values.includes(session.retestId) && values.includes(session.courseId) ? [{ not_before_at: "2020-01-01T00:00:00Z", recommended_at: null, scheduled_start_at: null }] : [];
    if (query.includes("UPDATE opening_teaching_activities")) return [{ id: session.activityId }];
    throw new Error(`Unexpected SQL: ${query}`);
  }, { json: (value: unknown) => value });
  const sql = { begin: (run: (value: unknown) => unknown) => run(tx) } as unknown as Sql;
  serviceIO.decision.mockImplementation(async (_tx, _scope, input) => ({ id: id(), ...input }));
  return (input: unknown) => createSpanSessionService(sql).prepare(scope, input);
}
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
    intent: { purpose: "self_study", timeBudgetMinutes: 20, language: "zh", pace: "normal", continuous: true, selfReportedFatigue: "unknown" }, moveId: "self_study-reserved", status: "active", revision: 1, createdAt: "2026-10-31T00:00:00Z", updatedAt: "2026-10-31T00:00:00Z" };
  const attempt: LearningAttempt = { id: id(), workspaceId: id(), sessionId, courseId, sourceIds: [sourceId], sourceVersions: { [sourceId]: 1 }, skillLabel: "span", requirementKey: null, problemId: id(), itemVersionId: id(), startedAt: session.createdAt, submittedAt: null, observationId: null, historyRevision: 0,
    spanExercise: { ...getSpanProblem("span-independent-3d")!, id: "span-reserved-generated-retest-independent-2d-1729-0" } };
  const details = { session, attempts: [] as LearningAttempt[], observations: [], assistance: {}, hintLevels: {}, intentEvent: null };
  return { session, attempt, details };
}
afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear(); mocks.enabled = true; });
it.each([false, true])("routes due retest with v2=%s, submits its canonical identity and resumes the original task", async enabled => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); mocks.enabled = enabled;
  const { session, attempt, details } = fixture();
  const routeAlias = session.retestId!;
  const record = { id: id(), assistance: "hinted", serverEvaluation: { decision: "correct", reasonCodes: ["verified_exactly"] } } as LearningObservation;
  let created = false, saved = false, prepared = false;
  const prepare = prepareFor(session);
  mocks.read.mockImplementation(async () => ({ observation: saved ? record : null, deliveredAssistance: "hinted" }));
  mocks.getAttemptContext.mockResolvedValue({ attempt });
  mocks.request.mockImplementation(async (path: string, _schema: unknown, init?: RequestInit) => {
    if (path.includes("/lesson") && init?.method === "POST") { created = true; return session; }
    if (path.includes("/lesson") && init?.method === "PATCH") return { ...session, ...JSON.parse(String(init.body)), revision: 2 };
    if (path.includes("/lesson")) return { ...details, session: created ? session : null };
    if (path.endsWith("/session")) { const result = await prepare(JSON.parse(String(init?.body))); prepared = true; return result; }
    if (path.endsWith("/reserved")) { expect(prepared).toBe(true); return attempt; }
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
    expect(JSON.parse(String(plan![2].body))).toMatchObject({ sessionId: session.sessionId, retestId: session.retestId, moveId: "self-independent" });
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
it.each([["overview", "overview-mixed"], ["challenge", "challenge-transfer"]] as const)("prepares a new %s retest with its existing independent action", async (purpose, moveId) => {
  const { session, attempt, details } = fixture();
  session.intent = { ...session.intent, purpose }; session.moveId = `${purpose}-reserved`;
  const prepare = prepareFor(session); let prepared = false;
  mocks.request.mockImplementation(async (path: string, _schema: unknown, init?: RequestInit) => {
    const input = JSON.parse(String(init?.body));
    if (path.endsWith("/session")) { expect(input.moveId).toBe(moveId); const result = await prepare(input); prepared = true; return result; }
    if (path.endsWith("/reserved")) { expect(prepared).toBe(true); expect(input).toMatchObject({ sessionId: session.sessionId, mode: purpose }); return attempt; }
    throw new Error(`Unexpected request ${path}`);
  });
  mocks.read.mockResolvedValue({ observation: null, deliveredAssistance: "none" });
  const save = vi.fn(), port = createSpanStudySession(details, save);
  expect((await port.load()).step).toMatchObject({ kind: "question", purpose: "retest", attemptRef: { id: attempt.id } });
  expect(session.moveId).toBe(`${purpose}-reserved`); expect(save).not.toHaveBeenCalled();
  expect(mocks.hint).not.toHaveBeenCalled(); expect(mocks.createAttempt).not.toHaveBeenCalled();
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
it.each([false, true])("restores confirmed legacy alias B through the real lesson entry and refresh (sealed=%s)", async sealed => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const { session, attempt } = fixture(), alias = id();
  const scope = spanPracticeScope(session.courseId, alias, undefined, session.activityId, "reserved:auto");
  const ordinary = spanPracticeScope(session.courseId, undefined, undefined, session.activityId, "reserved:auto");
  const other = spanPracticeScope(session.courseId, id(), undefined, session.activityId, "reserved:auto");
  initializePracticeDraft(emptyPracticeDraft(ordinary, { answer: "ordinary" }));
  initializePracticeDraft(emptyPracticeDraft(other, { answer: "other retest" }));
  const answer = JSON.stringify({ membership: "in_span", explanation: "旧 B 原始思考" });
  const input = { clientKey: `span-answer:${id()}`, answer, retestId: alias, assistance: "independent" as const, outcome: "unverified" as const, verdictSource: "self_report" as const };
  initializePracticeDraft(emptyPracticeDraft(scope, { answer, sourceId: session.sourceIds[0], spanProblemId: attempt.spanExercise!.id, skillLabel: "线性组合与 span", assistance: "independent" }));
  const key = `span-start:${id()}`;
  patchPracticeDraft(scope, {}, { attemptId: attempt.id, start: { clientKey: key, sessionId: session.sessionId, sessionInput: { courseId: session.courseId, activityId: session.activityId, sourceIds: session.sourceIds, skillLabel: "线性组合与 span" }, createInput: { sessionId: session.sessionId, clientKey: key, spanExercise: { sourceId: session.sourceIds[0]!, problemId: attempt.spanExercise!.id, version: 1 } } }, ...(sealed ? { submission: { attemptId: attempt.id, input } } : {}) }, sessionStorage);
  serviceIO.get.mockResolvedValue(session); serviceIO.listByActivity.mockResolvedValue([attempt]);
  serviceIO.matchesRetestReference.mockImplementation(async (_scope, course, canonical, incoming) => course === session.courseId && canonical === session.retestId && incoming === alias);
  const service = createSpanLessonSessionService({} as Sql);
  mocks.request.mockImplementation(async (path: string) => {
    const url = new URL(path, window.location.origin);
    if (!url.pathname.endsWith("/lesson")) throw new Error(`Unexpected request ${path}`);
    return service.read({ workspaceId: attempt.workspaceId, ownerUserId: id() }, url.searchParams.get("courseId")!, url.searchParams.get("activityId"), url.searchParams.get("retestId"));
  });
  mocks.getAttemptContext.mockResolvedValue({ attempt }); mocks.read.mockResolvedValue({ observation: null, deliveredAssistance: "none" });
  mocks.submitAttempt.mockRejectedValue(new Error("network unknown"));
  const props = { courseId: session.courseId, sourceIds: session.sourceIds, sourceLoadError: false, initialActivityId: session.activityId, delayedRetestId: alias };
  const host = document.createElement("div"); let root = createRoot(host);
  try {
    await act(async () => root.render(<SpanLessonSession {...props} />));
    expect(serviceIO.matchesRetestReference).toHaveBeenCalledWith(expect.anything(), session.courseId, session.retestId, alias);
    expect([...host.querySelectorAll("label")].find(node => node.textContent === "我的理由")?.querySelector("input")?.value).toBe("旧 B 原始思考");
    expect(mocks.getAttemptContext).toHaveBeenCalledWith(attempt.id);
    await act(async () => host.querySelector<HTMLButtonElement>("[data-primary-action]")!.click());
    const first = mocks.submitAttempt.mock.calls[0]!;
    expect(first[0]).toBe(attempt.id);
    if (sealed) expect(first[1]).toEqual(input);
    else expect(first[1]).toMatchObject({ retestId: alias, answer });
    await act(async () => root.unmount()); root = createRoot(host);
    await act(async () => root.render(<SpanLessonSession {...props} />));
    await act(async () => host.querySelector<HTMLButtonElement>("[data-primary-action]")!.click());
    expect(mocks.submitAttempt.mock.calls[1]).toEqual(first);
    expect(readPracticeDraft(scope, sessionStorage)?.submission).toEqual({ attemptId: attempt.id, input: first[1] });
    expect(readPracticeDraft(ordinary, sessionStorage)?.fields.answer).toBe("ordinary");
    expect(readPracticeDraft(other, sessionStorage)?.fields.answer).toBe("other retest");
    expect(mocks.hint).not.toHaveBeenCalled();
    const unconfirmed = id();
    mocks.getAttemptContext.mockClear();
    await act(async () => root.render(<SpanLessonSession {...props} delayedRetestId={unconfirmed} />));
    expect(host.textContent).toContain("本次学习不属于当前课程或复测任务");
    expect(mocks.getAttemptContext).not.toHaveBeenCalled();
    const unconfirmedScope = spanPracticeScope(session.courseId, unconfirmed, undefined, session.activityId, "reserved:auto");
    expect(readPracticeDraft(unconfirmedScope, sessionStorage)).toBeNull();
  } finally { await act(async () => root.unmount()); }
});
