// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getSpanProblem, solveSpanProblem, verifySpanAnswer } from "@aistudy/domain";
import type { LearningAttempt, LearningObservation } from "@aistudy/contracts";
import type { SpanLessonDetails } from "../teaching/span/span-session-client";
import { SpanLessonSession } from "../teaching/span/span-lesson-session";
import { createSpanStudySession } from "./adapters/span";
import { StudySession, StudySessionShell } from "./study-session-shell";
import type { StudySessionView } from "./model";

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

beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); sessionStorage.clear(); });
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

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
  return { host, root, button, click, select, type, unmount: () => act(async () => root.unmount()) };
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
  expect(view.next).toMatchObject({ reason: "请先授权导师安排。", href: `/opening/courses/${courseId}` });
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
  mocks.read.mockResolvedValue({ observation: saved, deliveredAssistance: "none" });
  const view = await port.primary();
  expect(mocks.submitAttempt.mock.calls[1]![1]).toEqual(mocks.submitAttempt.mock.calls[0]![1]);
  expect(view.result?.outcome).toBe("incorrect");
  expect(() => port.edit({ membership: "not_in_span" })).toThrow();
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
  await port.primary();
  expect(mocks.submitAttempt.mock.calls[0]![1]).toMatchObject({ workSource: { id: photoId, version: 1, physicalPage: 1 } });
});

it("a failed photo leaves no attachment on the text answer", async () => {
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
  const states: StudySessionView[] = [base, { ...base, answer: { membership: "in_span" } }, { ...base, sealed: true },
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
