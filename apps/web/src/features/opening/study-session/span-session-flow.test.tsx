// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getSpanProblem, solveSpanProblem, verifySpanAnswer } from "@aistudy/domain";
import { learningAttemptSchema, type LearningAttempt, type LearningObservation } from "@aistudy/contracts";
import { listSpanReservedProblems } from "@aistudy/domain/span-heldout-catalog";
import type { SpanLessonDetails } from "../teaching/span/span-session-client";
import { SpanLessonSession } from "../teaching/span/span-lesson-session";
import { createSpanStudySession } from "./adapters/span";
import { StudySession, StudySessionShell } from "./study-session-shell";
import { primaryAction, type QuestionStep, type StudySessionView } from "./model";
import { publishVerifiedSessionIdentity } from "../../auth/session-identity";
import { parsePracticeDraftCollection } from "../learning/practice-draft-storage";

const mocks = vi.hoisted(() => ({ createAttempt: vi.fn(), submitAttempt: vi.fn(), getAttemptContext: vi.fn(), preparePhotoWorkSource: vi.fn(),
  read: vi.fn(), request: vi.fn(), hint: vi.fn(), ack: vi.fn(async () => undefined), uploadFile: vi.fn(), addToCourse: vi.fn(), push: vi.fn() }));
vi.mock("../capabilities/capabilities-provider", () => ({ useOpeningCapabilities: () => ({ studySessionV2: true }) }));
vi.mock("../client/learning-client", () => ({ createOpeningLearningClient: () => mocks }));
vi.mock("../inbox/upload-client", () => ({ createUploadClient: () => ({ uploadFile: mocks.uploadFile }) }));
vi.mock("../library/material-organization-client", () => ({ createMaterialOrganizationClient: () => ({ addToCourse: mocks.addToCourse }) }));
vi.mock("../learning/practice-draft", async original => ({ ...await original<typeof import("../learning/practice-draft")>(), readPracticeRecord: mocks.read }));
vi.mock("../teaching/span/span-session-client", async original => ({ ...await original<typeof import("../teaching/span/span-session-client")>(), spanLessonRequest: mocks.request }));
vi.mock("../teaching/span/span-hint-client", async original => ({ ...await original<typeof import("../teaching/span/span-hint-client")>(), requestSpanHint: mocks.hint }));
vi.mock("../assistant/study-exposure-ack", () => ({ acknowledgeStudyExposure: mocks.ack }));
vi.mock("../v3/motion/view-transition", () => ({ useTransitionRouter: () => ({ push: mocks.push, replace: vi.fn(), back: vi.fn() }) }));

const problem = getSpanProblem("span-faded-3d")!;
const solution = solveSpanProblem(problem);
const uuid = () => crypto.randomUUID();
function fixture(moveId = "self-faded", problemId = "span-faded-3d") {
  const exercise = getSpanProblem(problemId)!;
  const courseId = uuid(), sessionId = uuid(), activityId = uuid(), sourceId = uuid(), attemptId = uuid();
  const attempt = { id: attemptId, workspaceId: uuid(), sessionId, courseId, sourceIds: [sourceId], sourceVersions: { [sourceId]: 1 }, skillLabel: "span", requirementKey: null,
    problemId: uuid(), itemVersionId: uuid(), startedAt: "2026-10-31T00:00:00.000Z", submittedAt: null, observationId: null, historyRevision: 0,
    spanExercise: exercise, contextAnchor: { courseId, activityId, sourceId } } as unknown as LearningAttempt;
  const session = { activityId, sessionId, courseId, sourceIds: [sourceId], moveId, status: "active", revision: 1, retestId: null, createdAt: "2026-10-31T00:00:00.000Z",
    intent: { purpose: "self_study" as const, timeBudgetMinutes: 20, language: "zh" as const, pace: "normal" as const, continuous: true, selfReportedFatigue: "unknown" as const } };
  const details = { session, estimateMinutes: 12, attempts: [], observations: [], hintLevels: {}, assistance: {}, intentEvent: null } as unknown as SpanLessonDetails;
  return { attempt, details, courseId, activityId };
}
const hintResponse = (level: number) => ({ attemptId: "x", level, text: `提示${level}`, exposureReceipt: { id: uuid() } });

let releasePhotoIdentity: (() => void) | undefined;
function verifyPhotoAccount() {
  const identity = { id: uuid(), workspaceId: uuid() };
  releasePhotoIdentity = publishVerifiedSessionIdentity(identity);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    expect(String(input)).toBe("/api/auth/me");
    return Response.json({ user: identity });
  }));
}
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); sessionStorage.clear(); });
afterEach(() => { releasePhotoIdentity?.(); releasePhotoIdentity = undefined; vi.unstubAllGlobals(); vi.clearAllMocks(); });

async function mount(port: ReturnType<typeof createSpanStudySession>) {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<StudySession port={port} />));
  const button = (text: string) => [...host.querySelectorAll("button")].find(node => node.textContent?.includes(text));
  const click = async (text: string) => { const node = button(text); expect(node, text).toBeDefined(); await act(async () => node!.click()); };
  const select = async (value: string, label?: string) => {
    const node = label ? [...host.querySelectorAll("label")].find(row => row.textContent?.startsWith(label))!.querySelector("select")! : host.querySelector("select")!;
    await act(async () => { node.value = value; node.dispatchEvent(new Event("change", { bubbles: true })); });
  };
  const type = async (label: string, value: string) => {
    const node = [...host.querySelectorAll("label")].find(row => row.textContent?.startsWith(label))!.querySelector("input")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { setter.call(node, value); node.dispatchEvent(new Event("input", { bubbles: true })); });
  };
  const confidence = () => {
    const options = [...host.querySelectorAll("footer [role='group'][aria-label='作答前的把握'] button")] as HTMLButtonElement[];
    return options.length ? { pressed: options.filter(node => node.getAttribute("aria-pressed") === "true").map(node => node.textContent), locked: options.every(node => node.disabled) } : null;
  };
  return { host, root, button, click, select, type, confidence, unmount: () => act(async () => root.unmount()) };
}

it("submits a gradable self-study answer and saves the next lesson move without tutor authorization", async () => {
  if (solution.kind !== "unique") throw new Error("fixture");
  const { attempt, details } = fixture();
  const record = { id: uuid(), assistance: "hinted", serverEvaluation: { decision: "correct", reasonCodes: ["verified_exactly"] } } as unknown as LearningObservation;
  mocks.request.mockImplementation(async (path: string) => {
    if (path.endsWith("/next")) throw new Error("Tutor authorization is not available for this course");
    return {};
  });
  mocks.createAttempt.mockResolvedValue(attempt);
  mocks.read.mockResolvedValueOnce({ observation: null, deliveredAssistance: "none" }).mockResolvedValue({ observation: record, deliveredAssistance: "hinted" });
  mocks.hint.mockImplementation(async (_attempt: unknown, level: number) => hintResponse(level));
  mocks.submitAttempt.mockResolvedValue(record);
  const save = vi.fn(async () => true);
  const ui = await mount(createSpanStudySession(details, save));
  try {
    expect(ui.host.querySelectorAll("[data-primary-action]")).toHaveLength(1);
    expect(ui.host.textContent).toContain("约 12 分钟");
    expect(ui.confidence()).toEqual({ pressed: [], locked: false });
    // Faded example opens with hint 1 exactly once (legacy rule); it is disclosed, not hidden.
    expect(mocks.hint).toHaveBeenCalledTimes(1);
    expect(ui.button("提示 · 已看 1")).toBeDefined();
    expect(mocks.ack).toHaveBeenCalledTimes(1);
    expect((ui.button("提交") as HTMLButtonElement).disabled).toBe(true);
    await ui.select("in_span");
    await ui.type("α", solution.coefficients[0]); await ui.type("β", solution.coefficients[1]);
    await ui.click("提交");
    const input = mocks.submitAttempt.mock.calls[0]![1];
    expect(verifySpanAnswer(problem, JSON.parse(input.answer)).outcome).toBe("correct");
    expect(input.assistance).toBe("hinted");
    // Skipping sends no key at all, and leaves no locked choice to show.
    expect(input).not.toHaveProperty("preAnswerConfidence");
    expect(ui.confidence()).toBeNull();
    expect(ui.host.textContent).toContain("用提示后答对");
    // Help stays reachable after the first answer; that is when the full demonstration opens.
    expect(ui.button("提示 · 已看 1")).toBeDefined();
    expect(ui.host.querySelectorAll("[data-primary-action]")).toHaveLength(1);
    expect(save).not.toHaveBeenCalled();
    await ui.click("看下一步安排");
    expect(save).toHaveBeenCalledExactlyOnceWith((details as { session: { intent: unknown } }).session.intent, "self-independent", "active");
    expect(mocks.request.mock.calls.some(call => String(call[0]).endsWith("/next"))).toBe(false);
    expect(mocks.push).not.toHaveBeenCalled();
  } finally { await ui.unmount(); }
});

it.each(["span-faded-3d", "span-independent-3d"])("redos %s through the real form and verifier while keeping the first observation", async problemId => {
  const { attempt, details } = fixture(problemId === "span-faded-3d" ? "self-faded" : "self-independent", problemId);
  const redoAttempt = { ...attempt, id: uuid() };
  const variant = learningAttemptSchema.parse({ ...attempt, id: uuid(), contextAnchor: undefined,
    spanExercise: listSpanReservedProblems("validation").find(p => p.familyId === attempt.spanExercise!.familyId), historyRevision: 3, spanPracticeOriginAttemptId: redoAttempt.id });
  mocks.createAttempt.mockReset();
  const observations = new Map<string, LearningObservation>();
  mocks.request.mockImplementation(async (path: string, schema: { parse: (raw: unknown) => unknown }) => schema.parse(path.endsWith("/reserved") ? variant : {}));
  mocks.createAttempt.mockResolvedValueOnce(attempt).mockResolvedValueOnce(redoAttempt);
  mocks.hint.mockImplementation(async (_attempt: unknown, level: number) => hintResponse(level));
  mocks.read.mockImplementation(async (_client, _course, current) => ({ observation: observations.get(current.id) ?? null, deliveredAssistance: "none" }));
  mocks.submitAttempt.mockImplementation(async (attemptId, input) => {
    if (observations.has(attemptId)) throw new Error("first observation must not be overwritten");
    const result = verifySpanAnswer(attemptId === variant.id ? variant.spanExercise! : attempt.spanExercise!, JSON.parse(input.answer));
    const row = { id: uuid(), attemptId, answer: input.answer, assistance: input.assistance,
      serverEvaluation: { evaluatorVersion: "span-exact-v1", decision: result.outcome === "incorrect" ? "incorrect" : result.outcome === "correct" && result.coreEvidenceComplete ? "correct" : "abstain", reasonCodes: [result.reason] } } as LearningObservation;
    observations.set(attemptId, row); return row;
  });
  const save = vi.fn(async () => true), ui = await mount(createSpanStudySession(details, save));
  try {
    await ui.select("in_span"); await ui.type("α", "9"); await ui.type("β", "9");
    await ui.click("有把握");
    await ui.click("提交");
    const first = structuredClone(observations.get(attempt.id));
    expect(mocks.submitAttempt.mock.calls[0]![1].preAnswerConfidence).toBe("confident");
    expect(ui.confidence()).toEqual({ pressed: ["有把握"], locked: true });
    expect(ui.host.textContent).toContain("还没对");
    expect(ui.host.querySelector("[data-primary-action]")?.textContent).toBe("改这道题");
    expect(ui.button("看下一步安排")).toBeDefined();
    expect(ui.host.querySelectorAll("[data-primary-action]")).toHaveLength(1);
    await act(async () => (ui.host.querySelector("[data-primary-action]") as HTMLButtonElement).click());
    expect(save).not.toHaveBeenCalled();
    expect(mocks.request.mock.calls.some(call => String(call[0]).endsWith("/next"))).toBe(false);
    expect(ui.host.querySelector("select")!.disabled).toBe(false);
    expect([...ui.host.querySelectorAll("input")].some(input => input.value === "9")).toBe(true);
    expect(ui.confidence()).toEqual({ pressed: [], locked: false });
    const exercise = attempt.spanExercise!;
    await ui.type("α·v + β·w = u 中的 v", exercise.vectors[0].join(", "));
    await ui.type("α·v + β·w = u 中的 w", exercise.vectors[1].join(", "));
    await ui.type("α·v + β·w = u 中的 u", exercise.target.join(", "));
    if (problemId === "span-faded-3d") {
      await ui.type("α", "2"); await ui.type("β", "-1");
      await ui.type("代回后", exercise.target.join(", "));
    } else {
      await ui.select("not_in_span"); await ui.type("α", "2"); await ui.type("β", "2");
      await ui.type("代回后", "2, 4, 2");
      await ui.select("0", "导出系数所用坐标 1"); await ui.select("2", "导出系数所用坐标 2");
    }
    await ui.click("提交");
    expect(mocks.submitAttempt.mock.calls[1]![1]).not.toHaveProperty("preAnswerConfidence");
    expect(ui.host.textContent).toContain("用提示后答对");
    expect(ui.button("改这道题")).toBeUndefined();
    expect(observations.size).toBe(2);
    expect(observations.get(attempt.id)).toEqual(first);
    expect(observations.get(redoAttempt.id)?.assistance).toBe("hinted");
    const stored = JSON.parse(sessionStorage.getItem(Object.keys(sessionStorage).find(key => key.startsWith("opening-practice:v2:"))!)!);
    expect(stored.drafts).toHaveLength(2);
    expect(stored.drafts[0]).toMatchObject({ attemptId: attempt.id, observationId: first!.id, submission: { input: { answer: first!.answer } } });
    mocks.getAttemptContext.mockResolvedValue({ attempt: redoAttempt });
    const restored = await createSpanStudySession(details, save).load();
    expect(restored.result).toMatchObject({ outcome: "correct", assistance: "hinted" });
    expect(mocks.submitAttempt.mock.calls[1]![1].clientKey).not.toBe(mocks.submitAttempt.mock.calls[0]![1].clientKey);
    const hintCount = mocks.hint.mock.calls.length;
    await ui.click("同族新题，独立做一次");
    expect(save).not.toHaveBeenCalled();
    expect(mocks.hint).toHaveBeenCalledTimes(hintCount);
    expect(ui.host.querySelector("section[aria-label='作答结果']")).toBeNull();
    expect(ui.host.querySelector("select")!.value).toBe("");
    expect(ui.confidence()).toEqual({ pressed: [], locked: false });
    expect(variant.spanExercise!.familyId).toBe(exercise.familyId);
    expect(variant.spanExercise!.target).not.toEqual(exercise.target);
    const request = mocks.request.mock.calls.find(call => String(call[0]).endsWith("/reserved"))!;
    expect(JSON.parse(request[2].body).afterAttemptId).toBe(redoAttempt.id);
    mocks.getAttemptContext.mockResolvedValue({ attempt: variant });
    expect((await createSpanStudySession(details, save).load()).step.id).toBe(variant.id);
    expect(mocks.request.mock.calls.filter(call => String(call[0]).endsWith("/reserved"))).toHaveLength(1);
    if (problemId === "span-faded-3d") {
      await ui.click("提示");
      await ui.click("看第 1 步");
    }
    const p = variant.spanExercise!, solved = solveSpanProblem(p);
    await ui.select(solved.kind === "none" ? "not_in_span" : "in_span");
    await ui.type("α·v + β·w = u 中的 v", p.vectors[0].join(", "));
    await ui.type("α·v + β·w = u 中的 w", p.vectors[1].join(", "));
    await ui.type("α·v + β·w = u 中的 u", p.target.join(", "));
    if (solved.kind === "unique") {
      await ui.type("α", solved.coefficients[0]); await ui.type("β", solved.coefficients[1]);
      await ui.type("代回后", p.target.join(", "));
    } else {
      await ui.type("α", "3"); await ui.type("β", "2"); await ui.type("代回后", "3, 2, 4");
      await ui.select("0", "导出系数所用坐标 1"); await ui.select("1", "导出系数所用坐标 2");
    }
    await ui.click("提交");
    expect(observations.get(variant.id)).toMatchObject({ assistance: problemId === "span-faded-3d" ? "hinted" : "independent", serverEvaluation: { decision: "correct" } });
    expect(observations.get(attempt.id)).toEqual(first);
    // A new tab has no active local draft: recover the precise server-owned successor.
    const resumedDetails = { ...details, session: { ...details.session!, activityId: uuid() },
      attempts: [attempt, { ...redoAttempt, historyRevision: 2 }, variant], observations: [...observations.values()] };
    const resumed = await createSpanStudySession(resumedDetails, save).load();
    expect(resumed.step.id).toBe(variant.id);
    expect(resumed.result?.outcome).toBe("correct");
  } finally { await ui.unmount(); }
});

it.each(["self-faded", "self-independent", "last move", "overview", "challenge"])("continues after an incorrect %s without creating a redo", async scenario => {
  const adaptive = ["last move", "overview", "challenge"].includes(scenario);
  const { attempt, details, courseId, activityId } = fixture(
    scenario === "overview" ? "overview-contrast" : scenario === "challenge" ? "challenge-transfer" : scenario === "last move" ? "self_study-reserved" : scenario,
    scenario === "overview" ? "span-contrast-dependent" : scenario === "challenge" ? "span-geometry-transfer" : scenario === "self-faded" ? "span-faded-3d" : "span-independent-3d");
  mocks.hint.mockImplementation(async (_attempt: unknown, level: number) => hintResponse(level));
  if (scenario === "overview" || scenario === "challenge") details.session!.intent.purpose = scenario;
  if (scenario === "last move") attempt.spanExercise = { ...attempt.spanExercise!, id: "span-reserved-fraction" };
  details.attempts = [attempt];
  const record = { id: uuid(), attemptId: attempt.id, answer: JSON.stringify({ membership: "in_span", coefficients: ["9", "9"] }),
    assistance: "independent", serverEvaluation: { decision: "incorrect", reasonCodes: [] } } as unknown as LearningObservation;
  const first = structuredClone(record);
  mocks.read.mockResolvedValue({ observation: record, deliveredAssistance: "none" });
  mocks.request.mockResolvedValue({ kind: "choice", reason: "authorization_required", message: "请先授权导师安排。", primary: { href: `/opening/courses/${courseId}`, label: "回到课程" } });
  let finish!: (saved: boolean) => void;
  const save = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
  const ui = await mount(createSpanStudySession(details, save));
  try {
    expect(ui.host.querySelector("[data-primary-action]")?.textContent).toBe("改这道题");
    expect(ui.host.querySelectorAll("[data-primary-action]")).toHaveLength(1);
    await ui.click("看下一步安排");
    if (adaptive) {
      expect(save).not.toHaveBeenCalled();
      expect(mocks.request).toHaveBeenCalledExactlyOnceWith("/api/opening/teaching/span/next", expect.anything(), expect.objectContaining({ method: "POST" }));
      expect(JSON.parse(mocks.request.mock.calls[0]![2].body)).toEqual({ activityId, expectedRevision: 1, observationId: record.id, clientKey: `span-next:${activityId}:1:${record.id}` });
      const notice = [...ui.host.querySelectorAll("section[aria-label='作答结果'] p")].find(node => node.textContent === "请先授权导师安排。");
      expect(notice?.closest("details")).toBeNull();
      await ui.click("看下一步安排");
      expect(mocks.push).toHaveBeenCalledExactlyOnceWith(`/opening/courses/${courseId}`);
      expect(mocks.request).toHaveBeenCalledTimes(1);
    } else {
      expect(save).toHaveBeenCalledExactlyOnceWith(details.session!.intent, scenario === "self-faded" ? "self-independent" : "self_study-reserved", "active");
      expect((ui.host.querySelector("[data-primary-action]") as HTMLButtonElement).disabled).toBe(true);
      expect(ui.button("看下一步安排")!.disabled).toBe(true);
      await ui.click("看下一步安排");
      expect(save).toHaveBeenCalledTimes(1);
      await act(async () => finish(true));
      expect(ui.button("看下一步安排")!.disabled).toBe(false);
      expect(mocks.request).not.toHaveBeenCalled();
      expect(mocks.push).not.toHaveBeenCalled();
    }
    expect(mocks.createAttempt).not.toHaveBeenCalled();
    expect(mocks.submitAttempt).not.toHaveBeenCalled();
    expect(record).toEqual(first);
  } finally { await ui.unmount(); }
});

it.each([false, true])("the final reserved step excludes answered practice variants (existing final: %s)", async hasFinal => {
  const { attempt, details } = fixture("self_study-reserved");
  const exercise = listSpanReservedProblems("validation").find(row => row.id === "span-reserved-20261021-q02")!;
  const variant = learningAttemptSchema.parse({ ...attempt, id: uuid(), contextAnchor: undefined,
    spanExercise: exercise, historyRevision: 5, spanPracticeOriginAttemptId: attempt.id });
  const final = learningAttemptSchema.parse({ ...attempt, id: uuid(), contextAnchor: undefined,
    spanExercise: listSpanReservedProblems("validation").find(row => row.id !== exercise.id && row.familyId === exercise.familyId), historyRevision: 4 });
  const solved = solveSpanProblem(exercise);
  if (solved.kind !== "unique") throw new Error("expected unique validation fixture");
  const answer = { membership: "in_span", coefficients: solved.coefficients,
    vectorEquation: { v: exercise.vectors[0], w: exercise.vectors[1], u: exercise.target }, substitutedVector: exercise.target };
  expect(verifySpanAnswer(exercise, answer).outcome).toBe("correct");
  const observation = { id: uuid(), attemptId: variant.id, answer: JSON.stringify(answer), assistance: "independent",
    serverEvaluation: { decision: "correct", reasonCodes: ["verified_exactly"] } } as LearningObservation;
  details.attempts = hasFinal ? [attempt, final, variant] : [attempt, variant];
  details.observations = [observation];
  mocks.read.mockImplementation(async (_client, _course, current) => ({ observation: current.id === variant.id ? observation : null, deliveredAssistance: "none" }));
  mocks.request.mockImplementation(async (path: string, schema: { parse: (raw: unknown) => unknown }) => schema.parse(path.endsWith("/reserved") ? final : {}));
  const port = createSpanStudySession(details, vi.fn());
  const view = await port.load();
  expect(view.step.id).toBe(final.id);
  expect(view.result).toBeNull();
  expect(view.answer).toEqual({});
  expect(view.canPracticeVariant).toBe(false);
  expect(mocks.read.mock.calls.every(call => call[2].id === final.id)).toBe(true);
  const requests = mocks.request.mock.calls.filter(call => String(call[0]).endsWith("/reserved"));
  expect(requests).toHaveLength(hasFinal ? 0 : 1);
  if (!hasFinal) expect(JSON.parse(requests[0]![2].body)).not.toHaveProperty("afterAttemptId");
  expect(mocks.request.mock.calls.some(call => String(call[0]).endsWith("/next"))).toBe(false);
  expect(mocks.createAttempt).not.toHaveBeenCalled();
});

it.each(["correct", "retest"])("does not offer redo for %s", async scenario => {
  const { attempt, details } = fixture("self-independent", "span-independent-3d");
  details.attempts = [attempt];
  if (scenario === "retest") {
    details.session!.retestId = uuid();
    attempt.spanExercise = { ...attempt.spanExercise!, id: "span-reserved-fraction" };
  }
  const record = { id: uuid(), answer: "{}", assistance: "independent", serverEvaluation: { decision: scenario === "correct" ? "correct" : "incorrect", reasonCodes: [] } } as unknown as LearningObservation;
  mocks.read.mockResolvedValue({ observation: record, deliveredAssistance: "none" });
  const view = await createSpanStudySession(details, vi.fn()).load();
  expect(view.canRedo).toBe(false);
});

it("the v2 lesson owner PATCHes progress and renders the next question after a submitted self-study result", async () => {
  const { attempt, details, courseId, activityId } = fixture("self-independent", "span-independent-3d");
  const record = { id: uuid(), assistance: "independent", serverEvaluation: { decision: "correct", reasonCodes: [] } } as unknown as LearningObservation;
  details.attempts = [attempt];
  const reserved = { ...attempt, id: uuid(), spanExercise: { ...attempt.spanExercise!, id: "span-reserved-fraction" } };
  mocks.read.mockImplementation(async (_client, _course, current) => ({ observation: current.id === attempt.id ? record : null, deliveredAssistance: "none" }));
  mocks.request.mockImplementation(async (path: string, _schema: unknown, init?: RequestInit) => {
    if (init?.method === "PATCH") return { ...details.session, ...JSON.parse(String(init.body)), revision: 2 };
    if (!init) return details;
    if (path.endsWith("/session")) return {};
    if (path.endsWith("/reserved")) return reserved;
    throw new Error(`Unexpected request: ${path}`);
  });
  const host = document.createElement("div"), root = createRoot(host); document.body.append(host);
  try {
    await act(async () => root.render(<SpanLessonSession courseId={courseId} sourceIds={attempt.sourceIds} sourceLoadError={false} initialActivityId={activityId} />));
    expect(host.textContent).toContain("独立答对");
    const next = [...host.querySelectorAll("button")].find(button => button.textContent?.includes("看下一步安排"));
    expect(next).toBeDefined(); await act(async () => next!.click());
    const patch = mocks.request.mock.calls.find(call => call[2]?.method === "PATCH")!;
    expect(patch[0]).toBe(`/api/opening/teaching/span/lesson?activityId=${activityId}`);
    expect(JSON.parse(patch[2].body)).toEqual({ expectedRevision: 1, intent: details.session!.intent, moveId: "self_study-reserved", status: "active" });
    expect(mocks.request.mock.calls.some(call => String(call[0]).endsWith("/next"))).toBe(false);
    expect(host.querySelector("ol[aria-label='第 4 步，共 4 步']")).not.toBeNull();
    expect(host.querySelector("section[aria-label='作答结果']")).toBeNull();
    expect(host.querySelector("select")).not.toBeNull();
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it.each(["last move", "retest", "overview"])("%s keeps the authorized adaptive next path instead of saving a lesson move", async scenario => {
  const { attempt, details, courseId, activityId } = fixture(scenario === "overview" ? "overview-contrast" : "self_study-reserved", scenario === "overview" ? "span-contrast-dependent" : "span-independent-3d");
  if (scenario === "overview") details.session!.intent.purpose = "overview";
  else attempt.spanExercise = { ...attempt.spanExercise!, id: "span-reserved-fraction" };
  if (scenario === "retest") details.session!.retestId = uuid();
  details.attempts = [attempt];
  const record = { id: uuid(), assistance: "independent", serverEvaluation: { decision: "correct", reasonCodes: [] } } as unknown as LearningObservation;
  mocks.read.mockResolvedValue({ observation: record, deliveredAssistance: "none" });
  mocks.request.mockResolvedValue({ kind: "choice", reason: "authorization_required", message: "请先授权导师安排。", primary: { href: `/opening/courses/${courseId}`, label: "回到课程" } });
  const save = vi.fn(async () => true), port = createSpanStudySession(details, save);
  await port.load();
  const view = await port.primary();
  expect(save).not.toHaveBeenCalled();
  expect(mocks.request).toHaveBeenCalledExactlyOnceWith("/api/opening/teaching/span/next", expect.anything(), expect.objectContaining({ method: "POST" }));
  expect(JSON.parse(mocks.request.mock.calls[0]![2].body)).toEqual({ activityId, expectedRevision: 1, observationId: record.id, clientKey: `span-next:${activityId}:1:${record.id}` });
  expect(view.next).toMatchObject({ notice: "请先授权导师安排。", href: `/opening/courses/${courseId}` });
});

it("a failed lesson save preserves the result for retry without requesting adaptive next", async () => {
  const { attempt, details } = fixture("self-independent", "span-independent-3d");
  details.attempts = [attempt];
  mocks.read.mockResolvedValue({ observation: { id: uuid(), assistance: "independent", serverEvaluation: null }, deliveredAssistance: "none" });
  const save = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true), port = createSpanStudySession(details, save);
  await port.load();
  await expect(port.primary()).rejects.toThrow("学习进度还没保存");
  expect((await port.primary()).result).not.toBeNull();
  expect(save).toHaveBeenCalledTimes(2);
  expect(mocks.request).not.toHaveBeenCalled();
});

it("reloading never requests a new hint level; it only re-reads released ones", async () => {
  const { attempt, details } = fixture("self-independent", "span-independent-3d");
  mocks.request.mockResolvedValue({}); mocks.createAttempt.mockResolvedValue(attempt);
  mocks.read.mockResolvedValue({ observation: null, deliveredAssistance: "none" });
  mocks.hint.mockImplementation(async (_attempt: unknown, level: number) => hintResponse(level));
  const port = createSpanStudySession(details, vi.fn());
  await port.load();
  expect(mocks.hint).not.toHaveBeenCalled();
  await port.help();
  expect(mocks.hint).toHaveBeenLastCalledWith(attempt, 1);
  // A reload (same tab: the draft remembers the attempt) replays exactly the server's released levels.
  mocks.getAttemptContext.mockResolvedValue({ attempt });
  const replay = createSpanStudySession({ ...(details as object), hintLevels: { [attempt.id]: [1] } } as never, vi.fn());
  mocks.hint.mockClear();
  const view = await replay.load();
  expect(mocks.hint.mock.calls.map(call => call[1])).toEqual([1]);
  expect(view.help.level).toBe("hinted");
});

it("replays the same sealed request after a network failure", async () => {
  const { attempt, details } = fixture("self-independent", "span-independent-3d");
  mocks.request.mockResolvedValue({}); mocks.createAttempt.mockResolvedValue(attempt);
  mocks.read.mockResolvedValue({ observation: null, deliveredAssistance: "none" });
  const port = createSpanStudySession(details, vi.fn());
  await port.load(); port.edit({ membership: "in_span" });
  const saved = { id: uuid(), assistance: "independent", serverEvaluation: { decision: "incorrect", reasonCodes: [] } } as unknown as LearningObservation;
  mocks.submitAttempt.mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce(saved);
  await expect(port.primary()).rejects.toThrow("network");
  // A skipped choice is sealed as skipped: a late choice cannot change the replayed request.
  expect(() => port.setConfidence!("confident")).toThrow("答案已提交");
  mocks.read.mockResolvedValue({ observation: saved, deliveredAssistance: "none" });
  const view = await port.primary();
  expect(mocks.submitAttempt.mock.calls[1]![1]).toEqual(mocks.submitAttempt.mock.calls[0]![1]);
  expect(mocks.submitAttempt.mock.calls[0]![1]).not.toHaveProperty("preAnswerConfidence");
  expect(view.result?.outcome).toBe("incorrect");
  expect(view.confidence).toBeUndefined();
  expect(() => port.edit({ membership: "not_in_span" })).toThrow();
});

it("seals the last confidence choice with the first answer and keeps it read-only", async () => {
  const { attempt, details } = fixture("self-independent", "span-independent-3d");
  details.estimateMinutes = null;
  mocks.request.mockResolvedValue({}); mocks.createAttempt.mockResolvedValue(attempt);
  mocks.read.mockResolvedValue({ observation: null, deliveredAssistance: "none" });
  const ui = await mount(createSpanStudySession(details, vi.fn()));
  try {
    // Without an estimate the top bar shows the learner's own session time.
    expect(ui.host.querySelector("header")!.textContent).toContain("本次时长 20 分钟");
    await ui.select("in_span");
    await ui.click("没把握"); expect(ui.confidence()).toEqual({ pressed: ["没把握"], locked: false });
    await ui.click("有把握"); expect(ui.confidence()).toEqual({ pressed: ["有把握"], locked: false });
    await ui.click("有把握"); expect(ui.confidence()).toEqual({ pressed: [], locked: false });
    await ui.click("有点把握");
    expect(ui.host.querySelectorAll("[data-primary-action]")).toHaveLength(1);
    mocks.submitAttempt.mockRejectedValueOnce(new Error("network"));
    await ui.click("提交");
    expect(mocks.submitAttempt.mock.calls[0]![1].preAnswerConfidence).toBe("somewhat_confident");
    // The first request is sealed: a later change is refused and the retry sends the same request.
    await ui.click("没把握");
    expect(ui.host.querySelector("[role='alert']")?.textContent).toContain("不能再修改");
    expect(ui.confidence()?.pressed).toEqual(["有点把握"]);
    const saved = { id: uuid(), assistance: "independent", serverEvaluation: { decision: "incorrect", reasonCodes: [] } } as unknown as LearningObservation;
    mocks.submitAttempt.mockResolvedValueOnce(saved);
    mocks.read.mockResolvedValue({ observation: saved, deliveredAssistance: "none" });
    await ui.click("提交");
    expect(mocks.submitAttempt.mock.calls[1]![1]).toEqual(mocks.submitAttempt.mock.calls[0]![1]);
    expect(ui.confidence()).toEqual({ pressed: ["有点把握"], locked: true });
    expect(ui.host.querySelectorAll("[data-primary-action]")).toHaveLength(1);
    // A refresh reads the value back from the sealed request in the saved draft.
    const key = Object.keys(sessionStorage).find(name => name.startsWith("opening-practice:v2:"))!;
    const stored = parsePracticeDraftCollection(JSON.parse(sessionStorage.getItem(key)!), key.slice("opening-practice:v2:".length));
    expect(stored?.drafts[0]?.submission?.input.preAnswerConfidence).toBe("somewhat_confident");
    mocks.getAttemptContext.mockResolvedValue({ attempt });
    expect((await createSpanStudySession(details, vi.fn()).load()).confidence).toEqual({ value: "somewhat_confident", locked: true });
  } finally { await ui.unmount(); }
});

it("a retest can record confidence while help stays closed", async () => {
  const { attempt, details } = fixture("self-independent", "span-independent-3d");
  details.session!.retestId = uuid();
  details.attempts = [{ ...attempt, spanExercise: { ...attempt.spanExercise!, id: "span-reserved-fraction" } }];
  mocks.read.mockResolvedValue({ observation: null, deliveredAssistance: "none" });
  mocks.submitAttempt.mockRejectedValueOnce(new Error("stop"));
  const ui = await mount(createSpanStudySession(details, vi.fn()));
  try {
    expect(ui.button("提示")).toBeUndefined();
    expect(ui.confidence()).toEqual({ pressed: [], locked: false });
    await ui.select("in_span");
    await ui.click("没把握");
    await ui.click("提交");
    expect(mocks.submitAttempt.mock.calls[0]![1]).toMatchObject({ retestId: details.session!.retestId, preAnswerConfidence: "not_confident" });
  } finally { await ui.unmount(); }
});

it("a no-solution answer filled in the real form is graded by the real verifier", async () => {
  const { attempt, details } = fixture("self-independent", "span-independent-3d");
  mocks.request.mockResolvedValue({}); mocks.createAttempt.mockResolvedValue(attempt);
  mocks.read.mockResolvedValue({ observation: null, deliveredAssistance: "none" });
  mocks.submitAttempt.mockResolvedValue({ id: uuid(), assistance: "independent", serverEvaluation: null });
  const ui = await mount(createSpanStudySession(details, vi.fn()));
  try {
    await ui.select("not_in_span");
    await ui.type("α", "2"); await ui.type("β", "2");
    await ui.type("代回后", "2, 4, 2");
    await ui.select("0", "导出系数所用坐标 1"); await ui.select("2", "导出系数所用坐标 2");
    mocks.read.mockResolvedValue({ observation: { id: uuid(), assistance: "independent", serverEvaluation: null }, deliveredAssistance: "none" });
    await ui.click("提交");
    const answer = JSON.parse(mocks.submitAttempt.mock.calls[0]![1].answer);
    expect(verifySpanAnswer(getSpanProblem("span-independent-3d")!, answer)).toMatchObject({ outcome: "correct", reason: "verified_exactly" });
  } finally { await ui.unmount(); }
});

it("the reserved step records a teaching move the session service accepts, then asks for the reserved item", async () => {
  const { attempt: base, details } = fixture("self_study-reserved", "span-independent-3d");
  const attempt = { ...base, spanExercise: { ...base.spanExercise!, id: "span-reserved-fraction" } } as LearningAttempt;
  mocks.request.mockImplementation(async (path: string) => path.endsWith("/reserved") ? attempt : {});
  mocks.read.mockResolvedValue({ observation: null, deliveredAssistance: "none" });
  await createSpanStudySession(details, vi.fn()).load();
  const session = mocks.request.mock.calls.find(call => String(call[0]).endsWith("/span/session"))!;
  expect(JSON.parse(session[2].body).moveId).toBe("self-independent");
  expect(mocks.request.mock.calls.some(call => String(call[0]).endsWith("/span/reserved"))).toBe(true);
  expect(mocks.createAttempt).not.toHaveBeenCalled();
});

it("an uploaded photo is attached to the answer without being added to the course", async () => {
  verifyPhotoAccount();
  const { attempt, details } = fixture("self-independent", "span-independent-3d");
  mocks.request.mockResolvedValue({}); mocks.createAttempt.mockResolvedValue(attempt);
  mocks.read.mockResolvedValue({ observation: null, deliveredAssistance: "none" });
  const photoId = uuid();
  mocks.uploadFile.mockResolvedValue({ id: photoId, version: 1 });
  mocks.preparePhotoWorkSource.mockResolvedValue({ attemptId: attempt.id, courseId: attempt.courseId, state: "ready", parseState: "ready", workSource: { id: photoId, version: 1, physicalPage: 1 } });
  const port = createSpanStudySession(details, vi.fn(), { photoEnabled: true });
  await port.load();
  expect((await port.choosePhoto(Object.assign(new File(["x"], "a.png", { type: "image/png" }), { arrayBuffer: async () => new ArrayBuffer(1) }))).photo?.status).toBe("ready");
  expect(mocks.addToCourse).not.toHaveBeenCalled();
  port.edit({ membership: "in_span" });
  mocks.submitAttempt.mockResolvedValue({ id: uuid(), assistance: "independent", serverEvaluation: null });
  mocks.read.mockResolvedValue({ observation: { id: uuid(), assistance: "independent", serverEvaluation: null }, deliveredAssistance: "none" });
  expect((await port.primary()).canRedo).toBe(false);
  expect(mocks.submitAttempt.mock.calls[0]![1]).toMatchObject({ workSource: { id: photoId, version: 1, physicalPage: 1 } });
});

it("a failed photo leaves no attachment on the text answer", async () => {
  verifyPhotoAccount();
  const { attempt, details } = fixture("self-independent", "span-independent-3d");
  mocks.request.mockResolvedValue({}); mocks.createAttempt.mockResolvedValue(attempt);
  mocks.read.mockResolvedValue({ observation: null, deliveredAssistance: "none" });
  mocks.uploadFile.mockResolvedValue({ phase: "failed", message: "上传失败" });
  const port = createSpanStudySession(details, vi.fn(), { photoEnabled: true });
  await port.load();
  expect((await port.choosePhoto(Object.assign(new File(["x"], "a.png", { type: "image/png" }), { arrayBuffer: async () => new ArrayBuffer(1) }))).photo?.status).toBe("failed");
  port.removePhoto(); port.edit({ membership: "in_span" });
  mocks.submitAttempt.mockResolvedValue({ id: uuid(), assistance: "independent", serverEvaluation: null });
  mocks.read.mockResolvedValue({ observation: { id: uuid(), assistance: "independent", serverEvaluation: null }, deliveredAssistance: "none" });
  await port.primary();
  expect(mocks.submitAttempt.mock.calls[0]![1]).not.toHaveProperty("workSource");
});

it("renders exactly one primary action in every state and no time when the backend has none", () => {
  const base: StudySessionView = { step: { kind: "question", id: "q", title: "span", prompt: "求系数", purpose: "practice", estimateMinutes: null, photo: false, coordinates: 3 },
    position: { index: 1, total: 4 }, help: { level: "none", hints: [], next: { level: 1, label: "方向提示" } }, answer: {}, sealed: false, result: null, next: null, photo: null };
  const redo = { ...base, canRedo: true, result: { outcome: "incorrect" as const, assistance: "hinted" as const } };
  expect(primaryAction(redo, false)).toMatchObject({ kind: "redo", disabled: false });
  expect(primaryAction(redo, true).disabled).toBe(true);
  for (const outcome of ["correct", "unknown", "pending", "needs_manual"] as const) {
    expect(primaryAction({ ...redo, result: { outcome, assistance: "unknown" } }, false).kind).not.toBe("redo");
  }
  expect(primaryAction({ ...redo, canRedo: false }, false).kind).not.toBe("redo");
  const states: StudySessionView[] = [base, redo, { ...base, answer: { membership: "in_span" } }, { ...base, sealed: true },
    { ...base, result: { outcome: "correct", assistance: "independent" } }, { ...base, result: { outcome: "incorrect", assistance: "hinted" }, next: { href: "/x", label: "再练一题", alternatives: [] } },
    { ...base, blocked: "资料不可用" }, { ...base, step: { kind: "learn", id: "l", title: "例题", body: "$x$", estimateMinutes: null } }];
  const host = document.createElement("div"); const root = createRoot(host);
  const noop = () => {};
  for (const view of states) {
    act(() => root.render(<StudySessionShell view={view} onPrimary={noop} onHelp={noop} onPause={noop} onReload={noop} onEdit={noop} onChoosePhoto={noop} onRemovePhoto={noop} />));
    expect(host.querySelectorAll("[data-primary-action]")).toHaveLength(1);
    expect(host.textContent).not.toContain("分钟");
  }
  act(() => root.unmount());
});

it("hides help before an unanswered retest and closes help when the same shell changes into one", () => {
  const base: StudySessionView = { step: { kind: "question", id: "q", title: "span", prompt: "求系数", purpose: "practice", estimateMinutes: null, photo: false, coordinates: 3 },
    position: { index: 1, total: 4 }, help: { level: "none", hints: [], next: { level: 1, label: "方向提示" } }, answer: {}, sealed: false, result: null, next: null, photo: null };
  const host = document.createElement("div"); const root = createRoot(host); document.body.append(host);
  const noop = () => {};
  act(() => root.render(<StudySessionShell view={base} onPrimary={noop} onHelp={noop} onPause={noop} onReload={noop} onEdit={noop} onChoosePhoto={noop} onRemovePhoto={noop} />));
  act(() => [...host.querySelectorAll("button")].find(button => button.textContent?.includes("提示"))?.click());
  expect(host.querySelector("aside[aria-label='提示']")).not.toBeNull();
  const retest = { ...base, step: { ...base.step, purpose: "retest" as const } };
  act(() => root.render(<StudySessionShell view={retest} onPrimary={noop} onHelp={noop} onPause={noop} onReload={noop} onEdit={noop} onChoosePhoto={noop} onRemovePhoto={noop} />));
  expect([...host.querySelectorAll("button")].some(button => button.textContent?.includes("提示"))).toBe(false);
  expect(host.querySelector("aside[aria-label='提示']")).toBeNull();
  act(() => root.unmount()); host.remove();
});

it("folds reasons under 为什么, keeps choices and blocks visible, shows time, and keeps one primary action beside confidence", () => {
  const question: QuestionStep = { kind: "question", id: "q", title: "span", prompt: "求系数", purpose: "practice", estimateMinutes: null, photo: false, coordinates: 3 };
  const base: StudySessionView = { step: question, position: { index: 1, total: 4 }, help: { level: "none", hints: [], next: null }, answer: {}, sealed: false, result: null, next: null, photo: null };
  const host = document.createElement("div"); const root = createRoot(host); document.body.append(host);
  const noop = () => {};
  const render = (view: StudySessionView) => act(() => root.render(<StudySessionShell view={view} onPrimary={noop} onHelp={noop} onPause={noop} onReload={noop} onEdit={noop} onChoosePhoto={noop} onRemovePhoto={noop} onConfidence={noop} />));
  const visible = (text: string) => [...host.querySelectorAll("p")].some(node => node.textContent === text && !node.closest("details"));
  try {
    render({ ...base, result: { outcome: "incorrect", assistance: "independent", detail: "第 2 个坐标对不上", nextStep: { label: "先回到原题重算", action: "重算第 2 个坐标" } },
      next: { href: "/x", label: "回到课程", notice: "请先授权导师安排。", reason: "最近两题都卡在同一步", alternatives: [] } });
    const section = host.querySelector("section[aria-label='作答结果']")!;
    expect(section.getAttribute("aria-live")).toBe("polite");
    const why = section.querySelector("details")!;
    expect(why.open).toBe(false);
    expect(why.querySelector("summary")?.textContent).toBe("为什么");
    for (const text of ["第 2 个坐标对不上", "下一步：先回到原题重算", "最近两题都卡在同一步"]) expect(why.textContent).toContain(text);
    expect(visible("还没对，原答案已保留")).toBe(true);
    expect(visible("请先授权导师安排。")).toBe(true);
    render({ ...base, result: { outcome: "correct", assistance: "independent" } });
    expect(host.querySelector("section[aria-label='作答结果']")).not.toBeNull();
    expect(host.querySelector("section[aria-label='作答结果'] details")).toBeNull();
    render({ ...base, blocked: "资料不可用" });
    expect(host.querySelector("[role='alert']")?.textContent).toBe("资料不可用");
    render({ ...base, budgetMinutes: 20 });
    expect(host.querySelector("header")?.textContent).toContain("本次时长 20 分钟");
    expect(host.querySelector("header")?.textContent).not.toMatch(/约|预计/);
    render({ ...base, step: { ...question, estimateMinutes: 12 }, budgetMinutes: 20 });
    expect(host.querySelector("header")?.textContent).toContain("约 12 分钟");
    expect(host.querySelector("header")?.textContent).not.toContain("本次时长");
    const states: StudySessionView[] = [base, { ...base, answer: { membership: "in_span" } }, { ...base, sealed: true },
      { ...base, sealed: true, canRedo: true, result: { outcome: "incorrect", assistance: "independent" } }];
    for (const confidence of [{ value: null, locked: false }, { value: "confident", locked: false }, { value: "confident", locked: true }] as const) {
      for (const view of states) {
        render({ ...view, confidence });
        expect(host.querySelectorAll("[role='group'][aria-label='作答前的把握'] button")).toHaveLength(3);
        expect(host.querySelectorAll("[data-primary-action]")).toHaveLength(1);
      }
    }
  } finally { act(() => root.unmount()); host.remove(); }
});
