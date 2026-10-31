// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LearningAttempt, LearningObservation, Scope, SpanLessonSnapshot } from "@aistudy/contracts";
import { learningAttemptSubmitInputSchema } from "@aistudy/contracts";
import { getSpanProblem, solveSpanProblem, verifySpanAnswer, SPAN_REQUIREMENT_KEY } from "@aistudy/domain";
import type { Sql } from "postgres";
import { emptyPracticeDraft, writePracticeDraft, readPracticeDraft, parsePracticeDraftCollection } from "../../learning/practice-draft-storage";
import { spanPracticeScope } from "./span-practice";
import { SpanLessonSession } from "./span-lesson-session";
import { createSpanStudySession } from "../../study-session/adapters/span";
import { createSpanSessionService } from "./session-service";
import { createSpanLessonSessionService } from "./lesson-session-service";

const mocks = vi.hoisted(() => ({ enabled: true, request: vi.fn(), hint: vi.fn(), getAttemptContext: vi.fn(), submitAttempt: vi.fn(), read: vi.fn(),
  get: vi.fn(), latest: vi.fn(), matchesRetestReference: vi.fn(), listByActivity: vi.fn(), levels: vi.fn(), heads: vi.fn(), exposures: vi.fn(),
  lock: vi.fn(), prior: vi.fn(), append: vi.fn(), state: vi.fn(), record: vi.fn(), push: vi.fn() }));
vi.mock("../../capabilities/capabilities-provider", () => ({ useOpeningCapabilities: () => ({ studySessionV2: mocks.enabled }) }));
vi.mock("./span-session-client", async original => ({ ...await original<typeof import("./span-session-client")>(), spanLessonRequest: mocks.request }));
vi.mock("../../client/learning-client", () => ({ createOpeningLearningClient: () => mocks }));
vi.mock("../../learning/practice-draft", async original => ({ ...await original<typeof import("../../learning/practice-draft")>(), readPracticeRecord: mocks.read }));
vi.mock("./span-hint-client", async original => ({ ...await original<typeof import("./span-hint-client")>(), requestSpanHint: mocks.hint }));
vi.mock("../../v3/motion/view-transition", async original => ({ ...await original<typeof import("../../v3/motion/view-transition")>(), useTransitionRouter: () => ({ push: mocks.push }) }));
vi.mock("./span-lesson", () => ({ SpanLesson: () => <p>旧复测流程</p> }));
vi.mock("./span-session-summary", () => ({ SpanSessionSummary: () => <p>原小结</p> }));
vi.mock("../../planning/plan-service", () => ({ createOpeningPlanService: () => ({ listTasks: async () => [] }) }));
vi.mock("@aistudy/database", async original => ({ ...await original<typeof import("@aistudy/database")>(),
  createOpeningSpanSessionRepository: () => ({ get: mocks.get, latest: mocks.latest, matchesRetestReference: mocks.matchesRetestReference, deliveredHintLevels: mocks.levels }),
  createOpeningLearningAttemptRepository: () => ({ listByActivity: mocks.listByActivity }),
  createOpeningLearningRepository: () => ({ listDeliveredExposures: mocks.exposures }),
  createOpeningStudyIntentRepository: () => ({ latest: async () => null }),
  createOpeningLearningAgendaRepository: () => ({ get: async () => null }),
  createOpeningLearningDecisionsRepository: () => ({ list: async () => [] }),
  readOpeningCourseObservationHeads: mocks.heads, readOpeningSpanTutorOriginChange: async () => undefined,
  lockWorkspaceLearningHistory: mocks.lock, readOpeningLearningDecisionByClientKey: mocks.prior,
  appendOpeningStudyIntentInTx: mocks.append, readOpeningLearnerState: mocks.state, recordOpeningLearningDecision: mocks.record,
}));
const uuid = () => crypto.randomUUID();
const scope: Scope = { workspaceId: uuid(), ownerUserId: uuid() };
function fixture(purpose: "self_study" | "overview" | "challenge" = "self_study", problemId = "span-faded-3d") {
  const session: SpanLessonSnapshot = { courseId: uuid(), sessionId: uuid(), activityId: uuid(), retestId: uuid(), sourceIds: [uuid()],
    intent: { purpose, timeBudgetMinutes: 20, language: "zh", pace: "normal", continuous: true, selfReportedFatigue: "unknown" },
    moveId: `${purpose}-reserved`, revision: 1, status: "active", createdAt: "2026-10-21T00:00:00Z", updatedAt: "2026-10-21T00:00:00Z" };
  const attempt: LearningAttempt = { id: uuid(), workspaceId: scope.workspaceId, courseId: session.courseId, sessionId: session.sessionId,
    sourceIds: session.sourceIds, sourceVersions: { [session.sourceIds[0]!]: 1 }, skillLabel: "线性组合与 span", requirementKey: SPAN_REQUIREMENT_KEY,
    historyRevision: 0, problemId: uuid(), itemVersionId: uuid(), startedAt: session.createdAt, submittedAt: null, observationId: null,
    contextAnchor: { courseId: session.courseId, activityId: session.activityId, sourceId: session.sourceIds[0]! },
    spanExercise: { ...getSpanProblem(problemId)!, id: "span-reserved-fraction" } };
  return { session, attempt, alias: uuid() };
}
function io(session: SpanLessonSnapshot, due = true) {
  const tx = Object.assign(vi.fn(async (parts: TemplateStringsArray) => {
    const query = parts.join("?");
    if (query.includes("FROM opening_learning_sessions")) return [{ id: session.sessionId, activity_id: session.activityId, course_id: session.courseId }];
    if (query.includes("FROM opening_retest_activities")) return [{ not_before_at: due ? "2000-01-01" : "2999-01-01", recommended_at: null, scheduled_start_at: null }];
    if (query.includes("UPDATE opening_teaching_activities")) return [{ id: session.activityId }];
    throw new Error(`Unexpected SQL: ${query}`);
  }), { json: (value: unknown) => value });
  return { begin: (run: (tx: unknown) => unknown) => run(tx) } as unknown as Sql;
}
function configure(session: SpanLessonSnapshot, attempt: LearningAttempt, alias: string, attempts: LearningAttempt[] = [attempt]) {
  mocks.get.mockImplementation(async (_scope, id) => id === session.activityId ? session : null);
  mocks.matchesRetestReference.mockImplementation(async (_scope, course, canonical, reference) => course === session.courseId && canonical === session.retestId && reference === alias);
  mocks.listByActivity.mockResolvedValue(attempts); mocks.levels.mockResolvedValue({}); mocks.heads.mockResolvedValue([]); mocks.exposures.mockResolvedValue([]);
  mocks.getAttemptContext.mockResolvedValue({ attempt }); mocks.read.mockResolvedValue({ observation: null, deliveredAssistance: "none" });
  const lesson = createSpanLessonSessionService({} as Sql), prepare = createSpanSessionService(io(session));
  let prepared = false;
  mocks.request.mockImplementation(async (path: string, _schema: unknown, init?: RequestInit) => {
    if (path.startsWith("/api/opening/teaching/span/lesson") && !init) {
      const url = new URL(path, window.location.origin);
      return lesson.read(scope, url.searchParams.get("courseId")!, url.searchParams.get("activityId"), url.searchParams.get("retestId"));
    }
    const input = JSON.parse(String(init?.body));
    if (path.endsWith("/session")) { const result = await prepare.prepare(scope, input); prepared = true; return result; }
    if (path.endsWith("/reserved")) { expect(prepared).toBe(true); expect(input).not.toHaveProperty("retestId"); return attempt; }
    if (init?.method === "PATCH") { Object.assign(session, input, { revision: session.revision + 1 }); return { ...session }; }
    if (path.endsWith("/next")) return { kind: "ready", href: `/opening/courses/${session.courseId}/study/span?lesson=${session.activityId}`, activityId: session.activityId, sessionId: session.sessionId, courseId: session.courseId, label: "下一题", resumed: false };
    throw new Error(`Unexpected request: ${path}`);
  });
}
let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.resetAllMocks(); mocks.enabled = true; vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); sessionStorage.clear();
  mocks.prior.mockResolvedValue(null); mocks.append.mockResolvedValue({ id: uuid(), version: 1 });
  mocks.state.mockResolvedValue({ stateVersion: "v1", sourceVersions: {}, dataAsOf: "2026-10-21T00:00:00Z" }); mocks.record.mockResolvedValue({ id: uuid() });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
async function render(session: SpanLessonSnapshot, alias: string) {
  await act(async () => root.render(<SpanLessonSession courseId={session.courseId} sourceIds={session.sourceIds} sourceLoadError={false} initialActivityId={session.activityId} delayedRetestId={alias} />));
}
async function click(text: string) {
  const node = [...host.querySelectorAll("button")].find(button => button.textContent?.includes(text) || button.getAttribute("aria-label") === text);
  expect(node, text).toBeDefined(); await act(async () => node!.click());
}
async function field(label: string, value: string) {
  const node = [...host.querySelectorAll("label")].find(row => row.textContent?.startsWith(label))!.querySelector("input,select")!;
  await act(async () => {
    if (node instanceof HTMLInputElement) Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(node, value);
    else (node as HTMLSelectElement).value = value;
    node.dispatchEvent(new Event(node instanceof HTMLInputElement ? "input" : "change", { bubbles: true }));
  });
}
function seed(session: SpanLessonSnapshot, attempt: LearningAttempt, retestId: string | undefined, answer: string) {
  const scopeKey = spanPracticeScope(session.courseId, retestId, undefined, session.activityId, "reserved:auto");
  const draft = emptyPracticeDraft(scopeKey, { sourceId: session.sourceIds[0], skillLabel: attempt.skillLabel, spanProblemId: attempt.spanExercise!.id, answer, assistance: "independent" });
  draft.attemptId = attempt.id;
  draft.start = { clientKey: `old-start:${uuid()}`, sessionId: session.sessionId, sessionInput: { courseId: session.courseId, activityId: session.activityId, sourceIds: session.sourceIds, skillLabel: attempt.skillLabel },
    createInput: { sessionId: session.sessionId, clientKey: "placeholder", spanExercise: { sourceId: session.sourceIds[0]!, problemId: attempt.spanExercise!.id, version: 1 } } };
  draft.start.createInput!.clientKey = draft.start.clientKey;
  expect(writePracticeDraft(draft, sessionStorage)).toBe(true); return { scopeKey, draft };
}
it.each(["self_study", "overview", "challenge"] as const)("%s reserved entry passes real prepare and due-time validation before issuing a question", async purpose => {
  const { session, attempt, alias } = fixture(purpose); configure(session, attempt, alias, []);
  const service = createSpanSessionService(io(session));
  await expect(service.prepare(scope, { sessionId: session.sessionId, intent: session.intent, clientKey: "invalid-reserved", moveId: session.moveId, retestId: session.retestId })).rejects.toThrow("教学动作");
  await expect(createSpanSessionService(io(session, false)).prepare(scope, { sessionId: session.sessionId, intent: session.intent, clientKey: "too-early-check", moveId: purpose === "self_study" ? "self-independent" : purpose === "overview" ? "overview-mixed" : "challenge-transfer", retestId: session.retestId })).rejects.toThrow();
  await render(session, alias);
  expect(host.querySelector("select")).not.toBeNull(); expect(host.textContent).not.toContain("学习位置已变化");
  const prepare = mocks.request.mock.calls.find(call => String(call[0]).endsWith("/session"))!;
  expect(JSON.parse(prepare[2].body)).toMatchObject({ sessionId: session.sessionId, retestId: session.retestId, moveId: purpose === "self_study" ? "self-independent" : purpose === "overview" ? "overview-mixed" : "challenge-transfer" });
  expect(mocks.request.mock.calls.filter(call => String(call[0]).endsWith("/reserved"))).toHaveLength(1);
  expect(mocks.hint).not.toHaveBeenCalled();
});
it.each(["span-faded-3d", "span-independent-3d"])("restores alias draft, seals %s through real verifier, remounts/replays, then follows next and pause/resume", async problemId => {
  const { session, attempt, alias } = fixture("self_study", problemId); configure(session, attempt, alias);
  const oldAnswer = JSON.stringify({ membership: "in_span", coefficients: ["0", "0"] });
  const { scopeKey, draft: original } = seed(session, attempt, alias, oldAnswer);
  const ordinary = seed(session, attempt, undefined, "ordinary sentinel"); const other = seed(session, attempt, uuid(), "other retest sentinel");
  await render(session, alias);
  expect(mocks.matchesRetestReference).toHaveBeenCalledWith(scope, session.courseId, session.retestId, alias);
  expect(mocks.getAttemptContext).toHaveBeenCalledWith(attempt.id); expect(host.querySelector("input")?.value).toBe("0");
  expect(verifySpanAnswer(attempt.spanExercise!, oldAnswer).outcome).toBe("incorrect");
  const solution = solveSpanProblem(attempt.spanExercise!);
  if (solution.kind === "unique") {
    await field("我的判断", "in_span"); await field("α", solution.coefficients[0]); await field("β", solution.coefficients[1]);
  } else {
    await field("我的判断", "not_in_span"); await field("α", "2"); await field("β", "2"); await field("代回后", "2, 4, 2");
    await field("导出系数所用坐标 1", "0"); await field("导出系数所用坐标 2", "2");
  }
  const record = { id: uuid(), assistance: "independent", serverEvaluation: { decision: "correct", reasonCodes: ["verified_exactly"] } } as unknown as LearningObservation;
  mocks.submitAttempt.mockImplementationOnce(async (_id, input) => {
    learningAttemptSubmitInputSchema.parse(input); expect(input.retestId).toBe(alias);
    expect(verifySpanAnswer(attempt.spanExercise!, input.answer).outcome).toBe("correct"); throw new Error("network failure");
  }).mockImplementation(async (_id, input) => { learningAttemptSubmitInputSchema.parse(input); return record; });
  await click("提交"); expect(host.textContent).toContain("network failure");
  const first = mocks.submitAttempt.mock.calls[0];
  expect(parsePracticeDraftCollection(JSON.parse(sessionStorage.getItem(`opening-practice:v2:${scopeKey}`)!), scopeKey)).not.toBeNull();
  await act(async () => root.unmount()); root = createRoot(host); await render(session, alias);
  expect(readPracticeDraft(scopeKey, sessionStorage)!.start).toEqual(original.start);
  mocks.read.mockResolvedValue({ observation: record, deliveredAssistance: "none" }); await click("提交");
  expect(mocks.submitAttempt.mock.calls[1]).toEqual(first); expect(host.textContent).toContain("独立答对");
  expect(readPracticeDraft(ordinary.scopeKey, sessionStorage)!.fields.answer).toBe("ordinary sentinel");
  expect(readPracticeDraft(other.scopeKey, sessionStorage)!.fields.answer).toBe("other retest sentinel");
  await click("看下一步安排"); await click("下一题"); expect(mocks.push).toHaveBeenCalled();
  await click("更多"); await click("暂停并保存"); expect(host.textContent).toContain("本次学习已暂停");
  await click("继续原来的步骤"); expect(host.textContent).toContain("独立答对");
});
it("keeps delivered help without restoring or actively requesting hints before the retest answer", async () => {
  const { session, attempt, alias } = fixture(); configure(session, attempt, alias);
  mocks.levels.mockResolvedValue({ [attempt.id]: [1, 4] }); mocks.exposures.mockResolvedValue(["revealed"]);
  const details = await createSpanLessonSessionService({} as Sql).read(scope, session.courseId, session.activityId, alias);
  const port = createSpanStudySession({ ...details, continuityRetestId: alias }, vi.fn());
  const view = await port.load(); expect(view.step).toMatchObject({ kind: "question", purpose: "retest" }); expect(view.help).toEqual({ level: "revealed", hints: [], next: null });
  await port.help(); expect(mocks.hint).not.toHaveBeenCalled();
  port.edit({ membership: "in_span", coefficients: ["1", "1"] }); mocks.submitAttempt.mockRejectedValue(new Error("stop"));
  await expect(port.primary()).rejects.toThrow("stop"); expect(mocks.submitAttempt.mock.calls[0]![1]).toMatchObject({ assistance: "revealed", retestId: alias });
});
it("flag off keeps the original entry and an unconfirmed alias never opens a new draft", async () => {
  const { session, attempt, alias } = fixture(); configure(session, attempt, alias); mocks.enabled = false;
  await render(session, alias); expect(host.textContent).toContain("旧复测流程");
  await act(async () => root.unmount()); root = createRoot(host); mocks.enabled = true;
  await render(session, uuid()); expect(host.textContent).toContain("本次学习不属于当前课程或复测任务");
  expect(mocks.submitAttempt).not.toHaveBeenCalled(); expect(sessionStorage.length).toBe(0);
});
it("recovers the server's original attempt without a browser draft or prepare, and uses canonical identity without an alias", async () => {
  const { session, attempt, alias } = fixture(); configure(session, attempt, alias);
  // Even an old example checkpoint is a question when the server binds a retest.
  session.moveId = "self-example";
  await render(session, alias);
  expect(host.querySelector("select")).not.toBeNull();
  expect(mocks.getAttemptContext).not.toHaveBeenCalled();
  expect(mocks.request.mock.calls.some(call => String(call[0]).endsWith("/session") || String(call[0]).endsWith("/reserved") || String(call[0]).endsWith("/presentation"))).toBe(false);
  const canonical = createSpanStudySession({ session, attempts: [attempt], observations: [], assistance: {}, hintLevels: {}, intentEvent: null }, vi.fn());
  await canonical.load(); canonical.edit({ membership: "in_span", coefficients: ["1", "1"] });
  mocks.submitAttempt.mockRejectedValue(new Error("sealed")); await expect(canonical.primary()).rejects.toThrow("sealed");
  expect(mocks.submitAttempt.mock.calls[0]).toMatchObject([attempt.id, { retestId: session.retestId }]);
});
it("same-mounted route changes never bind an unconfirmed alias to the previous details snapshot", async () => {
  const { session, attempt, alias } = fixture(); configure(session, attempt, alias);
  seed(session, attempt, alias, JSON.stringify({ membership: "in_span", coefficients: ["0", "0"] }));
  await render(session, alias);
  const unknownAlias = uuid();
  await render(session, unknownAlias);
  expect(host.textContent).toContain("本次学习不属于当前课程或复测任务");
  const unknownScope = spanPracticeScope(session.courseId, unknownAlias, undefined, session.activityId, "reserved:auto");
  expect(sessionStorage.getItem(`opening-practice:v2:${unknownScope}`)).toBeNull();
  expect(readPracticeDraft(unknownScope, sessionStorage)).toBeNull();
  expect(mocks.submitAttempt).not.toHaveBeenCalled();
});
