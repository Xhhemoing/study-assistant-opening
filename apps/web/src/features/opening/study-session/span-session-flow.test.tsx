// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildSpanTargetedExplanation, getSpanProblem, solveSpanProblem, verifySpanAnswer } from "@aistudy/domain";
import { learningAttemptSchema, type LearningAttempt, type LearningObservation } from "@aistudy/contracts";
import { listSpanReservedProblems } from "@aistudy/domain/span-heldout-catalog";
import { SpanLessonRequestError, type SpanLessonDetails } from "../teaching/span/span-session-client";
import { SpanLessonSession } from "../teaching/span/span-lesson-session";
import { createSpanStudySession } from "./adapters/span";
import { StudySession, StudySessionShell } from "./study-session-shell";
import { primaryAction, type QuestionStep, type StudySessionPort, type StudySessionView } from "./model";
import { publishVerifiedSessionIdentity } from "../../auth/session-identity";
import { parsePracticeDraftCollection } from "../learning/practice-draft-storage";

const mocks = vi.hoisted(() => ({ v2: true, createAttempt: vi.fn(), submitAttempt: vi.fn(), getAttemptContext: vi.fn(), preparePhotoWorkSource: vi.fn(),
  read: vi.fn(), request: vi.fn(), hint: vi.fn(), ack: vi.fn(async () => undefined), uploadFile: vi.fn(), addToCourse: vi.fn(), push: vi.fn() }));
vi.mock("../capabilities/capabilities-provider", () => ({ useOpeningCapabilities: () => ({ studySessionV2: mocks.v2 }) }));
vi.mock("../client/learning-client", () => ({ createOpeningLearningClient: () => mocks }));
vi.mock("../inbox/upload-client", () => ({ createUploadClient: () => ({ uploadFile: mocks.uploadFile }) }));
vi.mock("../library/material-organization-client", () => ({ createMaterialOrganizationClient: () => ({ addToCourse: mocks.addToCourse }) }));
vi.mock("../learning/practice-draft", async original => ({ ...await original<typeof import("../learning/practice-draft")>(), readPracticeRecord: mocks.read }));
vi.mock("../teaching/span/span-session-client", async original => ({ ...await original<typeof import("../teaching/span/span-session-client")>(), spanLessonRequest: mocks.request }));
vi.mock("../teaching/span/span-hint-client", async original => ({ ...await original<typeof import("../teaching/span/span-hint-client")>(), requestSpanHint: mocks.hint }));
vi.mock("../assistant/study-exposure-ack", () => ({ acknowledgeStudyExposure: mocks.ack }));
vi.mock("../teaching/span/span-tutor-control", () => ({ SpanTutorControl: () => null }));
vi.mock("../v3/motion/view-transition", () => ({ TransitionLink: "a", useTransitionRouter: () => ({ push: mocks.push, replace: vi.fn(), back: vi.fn() }) }));

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
beforeEach(() => { mocks.v2 = true; vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); sessionStorage.clear(); });
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

it("uses existing tutor admission for an explicitly selected next step after an exact coefficient error", async () => {
  const { attempt, details, courseId, activityId } = fixture();
  const answer = { membership: "in_span" as const, equation: { vectors: attempt.spanExercise!.vectors, target: attempt.spanExercise!.target },
    coefficients: ["9", "9"] as [string, string], coordinateChecks: ["9", "9", "18"], representations: { system: "unique" as const, geometry: "plane" as const } };
  const verified = verifySpanAnswer(attempt.spanExercise!, answer);
  expect(verified.skills).toMatchObject({ equation: "correct", coefficients: "incorrect", allCoordinates: "correct" });
  const record = { id: uuid(), attemptId: attempt.id, sessionId: attempt.sessionId, courseId, assistance: "hinted", answer: JSON.stringify(answer),
    serverEvaluation: { evaluatorVersion: "span-exact-v1", decision: verified.outcome, attemptId: attempt.id, itemVersionId: attempt.itemVersionId,
      problemId: attempt.problemId, skills: verified.skills, reasonCodes: [verified.reason] } } as unknown as LearningObservation;
  details.attempts = [attempt]; details.observations = [record];
  mocks.read.mockResolvedValue({ observation: record, deliveredAssistance: "hinted" });
  const nextId = uuid(), href = `/opening/courses/${courseId}/study/span?lesson=${nextId}`;
  mocks.request.mockResolvedValue({ kind: "ready", href, courseId, activityId: nextId, sessionId: uuid(), label: "开始针对性讲解", resumed: false });
  const save = vi.fn(async () => true);
  const ui = await mount(createSpanStudySession(details, save));
  try {
    expect(mocks.request).not.toHaveBeenCalled();
    await ui.click("看下一步安排");
    expect(mocks.request).toHaveBeenCalledExactlyOnceWith("/api/opening/teaching/span/next", expect.anything(), { method: "POST", body: JSON.stringify({
      activityId, expectedRevision: details.session!.revision, observationId: record.id, clientKey: `span-next:${activityId}:${details.session!.revision}:${record.id}` }) });
    expect(save).not.toHaveBeenCalled();
    expect(ui.host.textContent).toContain("开始针对性讲解");
    await ui.click("开始针对性讲解");
    expect(mocks.push).toHaveBeenCalledWith(href);
  } finally { await ui.unmount(); }
});

it("allows a normal grant update and explicit lesson reread to recheck tutor admission without a generic move", async () => {
  const { attempt, details, courseId, activityId } = fixture();
  const record = { id: uuid(), attemptId: attempt.id, sessionId: attempt.sessionId, courseId, assistance: "hinted", answer: "saved answer",
    serverEvaluation: { evaluatorVersion: "span-exact-v1", decision: "incorrect", attemptId: attempt.id, itemVersionId: attempt.itemVersionId, problemId: attempt.problemId, reasonCodes: [] } } as unknown as LearningObservation;
  details.attempts = [attempt]; details.observations = [record];
  mocks.read.mockResolvedValue({ observation: record, deliveredAssistance: "none" });
  mocks.request.mockResolvedValueOnce({ kind: "choice", reason: "authorization_required", message: "请先确认本课程导师授权。", primary: { href: `/opening/courses/${courseId}/study/span?lesson=${activityId}`, label: "核对导师授权" } });
  const save = vi.fn(async () => true), ui = await mount(createSpanStudySession(details, save));
  try {
    await ui.click("看下一步安排");
    expect(ui.host.textContent).toContain("请先确认本课程导师授权"); expect(save).not.toHaveBeenCalled();
    // The lesson owner's explicit reread rebuilds the port with current server facts.
    const nextId = uuid();
    mocks.request.mockResolvedValue({ kind: "ready", href: `/opening/courses/${courseId}/study/span?lesson=${nextId}`, courseId, activityId: nextId, sessionId: uuid(), label: "开始针对性讲解", resumed: false });
    mocks.getAttemptContext.mockResolvedValue({ attempt });
    await act(async () => ui.root.render(<StudySession port={createSpanStudySession(details, save)} />));
    await ui.click("看下一步安排");
    expect(mocks.request).toHaveBeenCalledTimes(2);
    expect(mocks.request.mock.calls[1]![0]).toBe(mocks.request.mock.calls[0]![0]);
    expect(mocks.request.mock.calls[1]![2]).toEqual(mocks.request.mock.calls[0]![2]); expect(save).not.toHaveBeenCalled();
    expect(ui.host.textContent).toContain("开始针对性讲解");
  } finally { await ui.unmount(); }
});

it("keeps a source/permission 409 blocked with pause available instead of retrying or issuing a generic question", async () => {
  const { details } = fixture();
  mocks.request.mockRejectedValue(new SpanLessonRequestError(409, "CONFLICT", "导师试用授权或课程状态已变化，请重新读取。"));
  const save = vi.fn(async () => true);
  const ui = await mount(createSpanStudySession(details, save));
  try {
    expect(ui.host.textContent).toContain("导师试用授权或课程状态已变化");
    expect(ui.host.textContent).not.toContain("正在准备这一步");
    expect(ui.button("暂时不能继续")?.disabled).toBe(true);
    expect(mocks.request).toHaveBeenCalledTimes(1); expect(mocks.createAttempt).not.toHaveBeenCalled();
    await act(async () => (ui.host.querySelector('button[aria-label="更多"]') as HTMLButtonElement).click()); await ui.click("暂停并保存");
    expect(save).toHaveBeenCalledWith(details.session!.intent, details.session!.moveId, "paused");
    expect(mocks.request).toHaveBeenCalledTimes(1);
  } finally { await ui.unmount(); }
});

it.each(["ordinary", "A", "B"] as const)("keeps %s drafts intact and suppresses redo/help after a question 409", async kind => {
  const { attempt, details } = fixture(kind === "ordinary" ? "self-independent" : "self-faded", "span-independent-3d");
  const bound = kind === "B" ? readyPrerequisite(details) : kind === "A" ? readyRepair(details) : details;
  mocks.request.mockResolvedValue(kind === "ordinary" ? {} : attempt);
  mocks.createAttempt.mockResolvedValue(attempt);
  mocks.read.mockResolvedValue({ observation: null, deliveredAssistance: "none" });
  const save = vi.fn(async () => true), original = createSpanStudySession(bound, save);
  await original.load(); original.edit({ membership: "in_span", coefficients: ["7", "8"] });
  const stored = () => Object.fromEntries(Object.keys(sessionStorage).map(key => [key, sessionStorage.getItem(key)]));
  const before = stored();
  const conflict = new SpanLessonRequestError(409, "CONFLICT", "当前题依据已变化，原草稿保留。");
  mocks.getAttemptContext.mockRejectedValue(conflict); mocks.request.mockRejectedValue(conflict);
  const port = createSpanStudySession(bound, save), view = await port.load();
  expect(view.blocked).toBe(conflict.message); expect(view.canRedo).toBeFalsy();
  const requests = mocks.request.mock.calls.length;
  await port.primary(); await port.redo!(); await port.help();
  expect(mocks.request).toHaveBeenCalledTimes(requests);
  expect(mocks.hint).not.toHaveBeenCalled(); expect(mocks.submitAttempt).not.toHaveBeenCalled();
  expect(stored()).toEqual(before); expect(save).not.toHaveBeenCalled();
  await port.pause(); expect(save).toHaveBeenCalledExactlyOnceWith(details.session!.intent, details.session!.moveId, "paused");
});

it.each(["self-example", "self-independent"])("ordinary %s blocks 409 but propagates non-409 errors", async moveId => {
  const { details } = fixture(moveId, "span-independent-3d");
  for (const status of [409, 503]) {
    const reason = new SpanLessonRequestError(status, "CONFLICT", `request status ${status}`);
    mocks.request.mockRejectedValue(reason);
    const port = createSpanStudySession(details, vi.fn());
    if (status === 409) expect((await port.load()).blocked).toBe(reason.message);
    else await expect(port.load()).rejects.toBe(reason);
  }
});

it("ordinary exact-wrong next 409 disables redo and help while retaining the first answer", async () => {
  const { attempt, details } = fixture("self-independent", "span-independent-3d");
  const record = { id: uuid(), attemptId: attempt.id, answer: "saved first answer", assistance: "hinted",
    serverEvaluation: { evaluatorVersion: "span-exact-v1", decision: "incorrect", attemptId: attempt.id,
      itemVersionId: attempt.itemVersionId, problemId: attempt.problemId, reasonCodes: [] } } as unknown as LearningObservation;
  details.attempts = [attempt]; details.observations = [record];
  mocks.read.mockResolvedValue({ observation: record, deliveredAssistance: "hinted" });
  mocks.request.mockRejectedValue(new SpanLessonRequestError(409, "CONFLICT", "下一步依据已变化"));
  const save = vi.fn(), port = createSpanStudySession(details, save);
  expect((await port.load()).canRedo).toBe(true);
  const view = await port.primary();
  expect(view).toMatchObject({ blocked: "下一步依据已变化", canRedo: false, next: null, help: { next: null } });
  await port.redo!(); await port.help(); await port.primary();
  expect(mocks.request).toHaveBeenCalledTimes(1); expect(mocks.hint).not.toHaveBeenCalled();
  expect(mocks.createAttempt).not.toHaveBeenCalled(); expect(mocks.submitAttempt).not.toHaveBeenCalled();
  expect(record.answer).toBe("saved first answer"); expect(save).not.toHaveBeenCalled();
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
      // The successor card carries the visible notice and the continue action; the footer keeps the redo primary.
      const card = ui.host.querySelector("ol[aria-label='学习对话'] section[aria-label='下一步']")!;
      const notice = [...card.querySelectorAll("p")].find(node => node.textContent === "请先授权导师安排。");
      expect(notice?.closest("details")).toBeNull();
      expect(ui.host.querySelector("footer [data-primary-action]")?.textContent).toBe("改这道题");
      expect(ui.host.querySelectorAll("[data-primary-action]")).toHaveLength(1);
      expect([...card.querySelectorAll("button")].map(node => node.textContent)).toEqual(["看下一步安排"]);
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
    // The answered question stays above as a read-only entry while the new port loads the next one.
    const done = host.querySelector(`ol[aria-label='学习对话'] li[aria-label^='之前的步骤']`)!;
    expect(done.textContent).toContain("独立答对");
    expect(done.querySelectorAll("input, select, textarea, button, fieldset")).toHaveLength(0);
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

it.each(["explanation", "route choice", "pause"])("remediation_limit exposes three choices and only the explicit %s action runs", async action => {
  const { attempt, details, courseId } = fixture("self_study-reserved", "span-independent-3d");
  attempt.spanExercise = { ...attempt.spanExercise!, id: "span-reserved-fraction" };
  details.attempts = [attempt];
  const record = { id: uuid(), assistance: "hinted", serverEvaluation: { decision: "incorrect", reasonCodes: [] } } as unknown as LearningObservation;
  mocks.read.mockResolvedValue({ observation: record, deliveredAssistance: "none" });
  let respond!: (value: unknown) => void;
  mocks.request.mockImplementation(() => new Promise(resolve => { respond = resolve; }));
  let finish!: (saved: boolean) => void;
  const save = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
  const port = createSpanStudySession(details, save), ui = await mount(port);
  try {
    expect(save).not.toHaveBeenCalled(); expect(mocks.request).not.toHaveBeenCalled(); expect(mocks.createAttempt).not.toHaveBeenCalled();
    await ui.click("看下一步安排");
    expect(save).not.toHaveBeenCalled();
    const choice = { kind: "choice", reason: "remediation_limit", message: "两轮纠偏后，请换讲法、到课程路线重新选择或暂缓。原记录保留。",
      primary: { label: "回原活动选择串讲", href: `/opening/courses/${courseId}/study/span?lesson=${details.session!.activityId}` },
      secondary: { label: "到课程路线重新选择", href: `/opening/courses/${courseId}?tab=units#course-learning-route` } };
    await act(async () => respond(choice));
    const card = ui.host.querySelector("section[aria-label='下一步']")!;
    expect(card.textContent).toContain(choice.message);
    expect(ui.button("换个讲法")).toBeDefined(); expect(ui.button("暂缓并保存")).toBeDefined();
    expect(ui.host.querySelectorAll("[data-primary-action]")).toHaveLength(1);
    expect(ui.button("改这道题")).toBeUndefined();
    const diagnostic = card.querySelector("a")!;
    expect(diagnostic.getAttribute("href")).toBe(choice.secondary.href);
    expect(diagnostic.textContent).toBe("到课程路线重新选择");
    expect(save).not.toHaveBeenCalled(); expect(mocks.push).not.toHaveBeenCalled();
    if (action === "route choice") {
      diagnostic.addEventListener("click", event => event.preventDefault());
      await act(async () => diagnostic.click());
      expect(save).not.toHaveBeenCalled(); expect(mocks.push).not.toHaveBeenCalled();
    } else {
      const label = action === "pause" ? "暂缓并保存" : "换个讲法";
      await act(async () => { ui.button(label)!.click(); ui.button(label)!.click(); });
      expect(save).toHaveBeenCalledTimes(1);
      expect(save).toHaveBeenLastCalledWith(action === "pause" ? details.session!.intent : { ...details.session!.intent, purpose: "overview" },
        action === "pause" ? details.session!.moveId : "overview-links", action === "pause" ? "paused" : "active");
      expect(ui.button("暂缓并保存")!.disabled).toBe(true);
      expect(diagnostic.getAttribute("aria-disabled")).toBe("true");
      await act(async () => finish(false));
      expect(ui.host.querySelector("[role='alert']")?.textContent).toContain(action === "pause" ? "暂停还没保存" : "讲法还没切换");
      expect(ui.host.textContent).toContain(choice.message);
      await ui.click(label);
      await act(async () => finish(true));
      expect(save).toHaveBeenCalledTimes(2);
      expect(ui.host.querySelector("[role='alert']")).toBeNull();
    }
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(mocks.createAttempt).not.toHaveBeenCalled(); expect(mocks.submitAttempt).not.toHaveBeenCalled(); expect(mocks.push).not.toHaveBeenCalled();
  } finally { await ui.unmount(); }
});

it("the v2 progress owner supplies the revision when switching to overview after remediation_limit", async () => {
  const { attempt, details, courseId, activityId } = fixture("self_study-reserved", "span-independent-3d");
  attempt.spanExercise = { ...attempt.spanExercise!, id: "span-reserved-fraction" }; details.attempts = [attempt];
  mocks.read.mockResolvedValue({ observation: { id: uuid(), assistance: "hinted", serverEvaluation: { decision: "incorrect", reasonCodes: [] } }, deliveredAssistance: "none" });
  mocks.request.mockImplementation(async (path: string, _schema: unknown, init?: RequestInit) => {
    if (!init) return details;
    if (init.method === "PATCH") return { ...details.session, ...JSON.parse(String(init.body)), revision: 9 };
    if (path.endsWith("/next")) return { kind: "choice", reason: "remediation_limit", message: "请选择换讲法、课程路线或暂缓。", primary: { href: `/opening/courses/${courseId}/study/span?lesson=${activityId}`, label: "回原活动" }, secondary: { href: `/opening/courses/${courseId}?tab=units#course-learning-route`, label: "到课程路线重新选择" } };
    if (path.endsWith("/presentation")) return { problem, solution, exposureReceipt: { id: uuid() } };
    throw new Error(`Unexpected request: ${path}`);
  });
  const host = document.createElement("div"), root = createRoot(host); document.body.append(host);
  const click = async (label: string) => act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === label)!.click());
  try {
    await act(async () => root.render(<SpanLessonSession courseId={courseId} sourceIds={attempt.sourceIds} sourceLoadError={false} initialActivityId={activityId} />));
    expect(mocks.request.mock.calls.some(call => call[2]?.method === "PATCH")).toBe(false);
    await click("看下一步安排");
    expect(mocks.request.mock.calls.some(call => call[2]?.method === "PATCH")).toBe(false);
    await click("换个讲法");
    expect(host.querySelector("ol[aria-label='第 1 步，共 4 步']")).not.toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="更多"]')!.click());
    await click("暂停并保存");
    const patches = mocks.request.mock.calls.filter(call => call[2]?.method === "PATCH");
    expect(patches.map(call => JSON.parse(call[2].body))).toEqual([
      { expectedRevision: 1, intent: { ...details.session!.intent, purpose: "overview" }, moveId: "overview-links", status: "active" },
      { expectedRevision: 9, intent: { ...details.session!.intent, purpose: "overview" }, moveId: "overview-links", status: "paused" },
    ]);
    expect(mocks.createAttempt).not.toHaveBeenCalled(); expect(mocks.push).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it.each(["系数代入后，第3坐标没对上。", undefined])("the v2 lesson carries recovered focus %s into the existing explanation, then explicitly advances within its activity", async targetedFocus => {
  const { attempt, details, courseId, activityId } = fixture("self-example");
  details.targetedFocus = targetedFocus;
  // This is the existing generic presentation, not a generated targeted lesson or proof of model quality.
  mocks.request.mockImplementation(async (path: string, _schema: unknown, init?: RequestInit) => {
    if (!init) return details;
    if (path.endsWith("/presentation")) return { problem, solution, exposureReceipt: { id: uuid() } };
    if (init.method === "PATCH") return { ...details.session, ...JSON.parse(String(init.body)), revision: 7 };
    if (path.endsWith("/session")) return {};
    throw new Error(`Unexpected request: ${path}`);
  });
  mocks.createAttempt.mockResolvedValue(attempt);
  mocks.read.mockResolvedValue({ observation: null, deliveredAssistance: "none" });
  mocks.hint.mockImplementation(async (_attempt: unknown, level: number) => hintResponse(level));
  const host = document.createElement("div"), root = createRoot(host); document.body.append(host);
  try {
    await act(async () => root.render(<SpanLessonSession courseId={courseId} sourceIds={attempt.sourceIds} sourceLoadError={false} initialActivityId={activityId} />));
    const focus = host.querySelector("section[aria-label='上次错在这一步']");
    if (targetedFocus) expect(focus?.textContent).toContain(targetedFocus);
    else expect(focus).toBeNull();
    expect(mocks.request.mock.calls.filter(call => call[2]?.method === "PATCH")).toHaveLength(0);
    expect(mocks.createAttempt).not.toHaveBeenCalled();
    expect(mocks.submitAttempt).not.toHaveBeenCalled();
    const presentation = mocks.request.mock.calls.find(call => String(call[0]).endsWith("/presentation"))!;
    expect(JSON.parse(presentation[2].body)).toEqual({ courseId, sourceId: attempt.sourceIds[0], sessionId: details.session!.sessionId,
      kind: "worked", clientKey: `span-demo:${details.session!.sessionId}:${attempt.sourceIds[0]}:worked:v1` });
    expect(mocks.ack).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: expect.any(String) }));
    expect(host.querySelector("[data-primary-action]")?.textContent).toBe("开始做题");
    await act(async () => host.querySelector<HTMLButtonElement>("[data-primary-action]")!.click());
    const patches = mocks.request.mock.calls.filter(call => call[2]?.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0]![0]).toBe(`/api/opening/teaching/span/lesson?activityId=${activityId}`);
    expect(JSON.parse(patches[0]![2].body)).toEqual({ expectedRevision: 1, intent: details.session!.intent, moveId: "self-faded", status: "active" });
    expect(host.querySelector("section[aria-label='上次错在这一步']")).toBeNull();
    expect(host.querySelector("select")).not.toBeNull();
    expect(mocks.createAttempt).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sessionId: details.session!.sessionId,
      spanExercise: { sourceId: attempt.sourceIds[0], problemId: "span-faded-3d", version: 1 } }));
    expect(mocks.request.mock.calls.some(call => String(call[0]).endsWith("/next"))).toBe(false);
    expect(mocks.submitAttempt).not.toHaveBeenCalled(); expect(mocks.push).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); host.remove(); }
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

it.each([false, true])("replays the same sealed request after a network failure B=%s", async b => {
  const { attempt, details } = fixture(b ? "self-faded" : "self-independent", "span-independent-3d");
  mocks.request.mockResolvedValue(b ? attempt : {}); mocks.createAttempt.mockResolvedValue(attempt);
  mocks.read.mockResolvedValue({ observation: null, deliveredAssistance: "none" });
  const bound = b ? readyPrerequisite(details) : details;
  const port = createSpanStudySession(bound, vi.fn());
  await port.load(); port.edit({ membership: "in_span" });
  const saved = { id: uuid(), attemptId: attempt.id, assistance: "independent", serverEvaluation: { evaluatorVersion: "span-exact-v1", attemptId: attempt.id,
    itemVersionId: attempt.itemVersionId, problemId: attempt.problemId, decision: "incorrect", reasonCodes: [] } } as unknown as LearningObservation;
  mocks.submitAttempt.mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce(saved);
  await expect(port.primary()).rejects.toThrow("network");
  expect(port.current!()?.sealed).toBe(true);
  if (b) {
    const restored = await createSpanStudySession(bound, vi.fn()).load();
    expect(restored.step.id).toBe(attempt.id); expect(restored.sealed).toBe(true); expect(restored.answer.membership).toBe("in_span");
    expect(mocks.submitAttempt).toHaveBeenCalledTimes(1);
  }
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

it("reads nothing back after a failed first load or before the first answer is sealed", async () => {
  const { attempt, details } = fixture("self-independent", "span-independent-3d");
  mocks.request.mockResolvedValue({}); mocks.createAttempt.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(attempt);
  mocks.read.mockResolvedValue({ observation: null, deliveredAssistance: "none" });
  const port = createSpanStudySession(details, vi.fn());
  await expect(port.load()).rejects.toThrow("offline");
  expect(port.current!()).toBeNull();
  await port.load(); port.edit({ membership: "in_span" });
  expect(port.current!()).toBeNull();
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
    expect(ui.host.querySelector("section[aria-label='我的作答']")).toBeNull();
    await ui.click("没把握"); expect(ui.confidence()).toEqual({ pressed: ["没把握"], locked: false });
    await ui.click("有把握"); expect(ui.confidence()).toEqual({ pressed: ["有把握"], locked: false });
    await ui.click("有把握"); expect(ui.confidence()).toEqual({ pressed: [], locked: false });
    await ui.click("有点把握");
    expect(ui.host.querySelectorAll("[data-primary-action]")).toHaveLength(1);
    mocks.submitAttempt.mockRejectedValueOnce(new Error("network"));
    await ui.click("提交");
    expect(mocks.submitAttempt.mock.calls[0]![1].preAnswerConfidence).toBe("somewhat_confident");
    // The first request is sealed: the failed screen is read-only at once and the retry sends the same request.
    expect(ui.host.querySelector("[role='alert']")?.textContent).toBe("network");
    expect(ui.confidence()).toEqual({ pressed: ["有点把握"], locked: true });
    expect(ui.host.querySelector("[data-primary-action]")?.textContent).toBe("重新确认提交");
    expect(ui.host.querySelector("fieldset")!.disabled).toBe(true);
    expect(ui.host.querySelector("section[aria-label='我的作答']")?.textContent).toContain("属于 span");
    const saved = { id: uuid(), assistance: "independent", serverEvaluation: { decision: "incorrect", reasonCodes: [] } } as unknown as LearningObservation;
    mocks.submitAttempt.mockResolvedValueOnce(saved);
    mocks.read.mockResolvedValue({ observation: saved, deliveredAssistance: "none" });
    await ui.click("重新确认提交");
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

it("shows the same sealed screen when the answer is saved but its result is not read yet", async () => {
  const { attempt, details } = fixture("self-independent", "span-independent-3d");
  mocks.request.mockResolvedValue({}); mocks.createAttempt.mockResolvedValue(attempt);
  mocks.read.mockResolvedValue({ observation: null, deliveredAssistance: "none" });
  const saved = { id: uuid(), assistance: "independent", serverEvaluation: { decision: "incorrect", reasonCodes: [] } } as unknown as LearningObservation;
  mocks.submitAttempt.mockResolvedValue(saved);
  const ui = await mount(createSpanStudySession(details, vi.fn()));
  try {
    await ui.select("in_span");
    await ui.click("有把握");
    await ui.click("提交");
    expect(ui.host.querySelector("[role='alert']")?.textContent).toContain("结果还没读到");
    expect(ui.confidence()).toEqual({ pressed: ["有把握"], locked: true });
    expect(ui.host.querySelector("[data-primary-action]")?.textContent).toBe("重新确认提交");
    expect(ui.host.querySelector("fieldset")!.disabled).toBe(true);
    await ui.click("提示");
    expect(ui.host.querySelector("aside[aria-label='提示']")?.textContent).toContain("先确认原答案已保存，再继续看提示。");
    mocks.read.mockResolvedValue({ observation: saved, deliveredAssistance: "none" });
    await ui.click("重新确认提交");
    expect(mocks.submitAttempt).toHaveBeenCalledTimes(2);
    expect(mocks.submitAttempt.mock.calls[1]![1]).toEqual(mocks.submitAttempt.mock.calls[0]![1]);
    expect(ui.host.querySelector("[role='alert']")).toBeNull();
    expect(ui.host.textContent).toContain("还没对，原答案已保留");
    expect(ui.confidence()).toEqual({ pressed: ["有把握"], locked: true });
  } finally { await ui.unmount(); }
});

it("a skipped choice stays hidden after a failed submit while the answer and photo turn read-only", async () => {
  const { attempt, details } = fixture("self-independent", "span-independent-3d");
  mocks.request.mockResolvedValue({}); mocks.createAttempt.mockResolvedValue(attempt);
  mocks.read.mockResolvedValue({ observation: null, deliveredAssistance: "none" });
  mocks.submitAttempt.mockRejectedValueOnce(new Error("network"));
  const ui = await mount(createSpanStudySession(details, vi.fn(), { photoEnabled: true }));
  try {
    const photo = () => ui.host.querySelector<HTMLInputElement>("input[type='file']")!;
    expect(photo().disabled).toBe(false);
    await ui.select("in_span");
    await ui.click("提交");
    expect(mocks.submitAttempt.mock.calls[0]![1]).not.toHaveProperty("preAnswerConfidence");
    expect(ui.host.querySelector("[role='alert']")?.textContent).toBe("network");
    expect(ui.confidence()).toBeNull();
    expect(ui.host.querySelector("fieldset")!.disabled).toBe(true);
    expect(photo().disabled).toBe(true);
    expect(ui.host.querySelector("[data-primary-action]")?.textContent).toBe("重新确认提交");
  } finally { await ui.unmount(); }
});

it("a refresh after a failed submit shows the same sealed choice and replay action as the failed screen", async () => {
  const { attempt, details } = fixture("self-independent", "span-independent-3d");
  mocks.request.mockResolvedValue({}); mocks.createAttempt.mockResolvedValue(attempt);
  mocks.read.mockResolvedValue({ observation: null, deliveredAssistance: "none" });
  const port = createSpanStudySession(details, vi.fn());
  await port.load(); port.edit({ membership: "in_span" }); port.setConfidence!("not_confident");
  mocks.submitAttempt.mockRejectedValueOnce(new Error("network"));
  await expect(port.primary()).rejects.toThrow("network");
  mocks.getAttemptContext.mockResolvedValue({ attempt });
  for (const view of [port.current!()!, await createSpanStudySession(details, vi.fn()).load()]) {
    expect(view.sealed).toBe(true);
    expect(view.confidence).toEqual({ value: "not_confident", locked: true });
    expect(primaryAction(view, false).label).toBe("重新确认提交");
  }
});

it.each(["confident", null] as const)("a new tab reads the server's saved choice %s back read-only", async saved => {
  const { attempt, details } = fixture("self-independent", "span-independent-3d");
  details.attempts = [{ ...attempt, preAnswerConfidence: saved }];
  mocks.read.mockResolvedValue({ observation: { id: uuid(), attemptId: attempt.id, assistance: "independent", serverEvaluation: { decision: "incorrect", reasonCodes: [] } }, deliveredAssistance: "none" });
  const view = await createSpanStudySession(details, vi.fn()).load();
  expect(view.sealed).toBe(false);
  expect(view.result?.outcome).toBe("incorrect");
  expect(view.confidence).toEqual(saved ? { value: saved, locked: true } : undefined);
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

it.each(["no read-back", "a null read-back", "a throwing read-back"] as const)("keeps the screen and the original error after a failure with %s", async readBack => {
  const view: StudySessionView = { step: { kind: "question", id: "q", title: "span", prompt: "求系数", purpose: "practice", estimateMinutes: null, photo: false, coordinates: 3 },
    position: { index: 1, total: 4 }, help: { level: "none", hints: [], next: null }, answer: { membership: "in_span" }, sealed: false, result: null, next: null, photo: null };
  const current = vi.fn((): StudySessionView | null => { if (readBack === "a throwing read-back") throw new Error("read-back"); return null; });
  const port: StudySessionPort = { load: async () => view, edit: () => view, primary: vi.fn(async () => { throw new Error("network"); }),
    help: async () => view, choosePhoto: async () => view, removePhoto: () => view, pause: async () => undefined,
    ...(readBack === "no read-back" ? {} : { current }) };
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => { rejections.push(reason); };
  process.on("unhandledRejection", onRejection);
  const host = document.createElement("div"), root = createRoot(host); document.body.append(host);
  const primary = () => host.querySelector<HTMLButtonElement>("[data-primary-action]")!;
  try {
    await act(async () => root.render(<StudySession port={port} />));
    expect(primary().textContent).toBe("提交");
    await act(async () => primary().click());
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(port.primary).toHaveBeenCalledTimes(1);
    expect(current).toHaveBeenCalledTimes(readBack === "no read-back" ? 0 : 1);
    expect(host.querySelector("[role='alert']")?.textContent).toBe("network");
    expect(primary().textContent).toBe("提交");
    expect(primary().disabled).toBe(false);
    expect(host.querySelector("fieldset")!.disabled).toBe(false);
    expect(rejections).toEqual([]);
  } finally { process.off("unhandledRejection", onRejection); await act(async () => root.unmount()); host.remove(); }
});


function readyRepair(details: SpanLessonDetails, targetSkill: "equation" | "coefficients" | "allCoordinates" = "equation"): SpanLessonDetails {
  return { ...details, repair: { status: "ready", version: 1, contentVersion: 1, targetSkill, focusSummary: "补当前已核验的步骤", prerequisiteStatus: "unknown" } };
}
function readyPrerequisite(details: SpanLessonDetails, targetSkill: "equation" | "coefficients" | "allCoordinates" = "equation"): SpanLessonDetails {
  const prerequisiteRequirement = { id: uuid(), revision: 1, stableSkillId: uuid(), requirementKey: "span:linear-combination:v1" };
  const targetRequirement = { ...prerequisiteRequirement, id: uuid(), stableSkillId: uuid(), requirementKey: "requirement:target" };
  return { ...details, prerequisiteRepair: { version: 1, status: "ready", targetSkill, focusSummary: "补直接前置的已核验步骤",
    prerequisiteRequirement, targetRequirement, returnToRequirementId: targetRequirement.id } };
}
const requestBodies = (suffix: string) => mocks.request.mock.calls.filter(call => String(call[0]).endsWith(suffix)).map(call => JSON.parse(call[2].body));

it.each([[true, false], [false, false], [true, true], [false, true]])("renders bounded lesson V2=%s B=%s without generic content, advances only explicitly and preserves original intent on pause failure", async (v2, b) => {
  mocks.v2 = v2;
  const { details, attempt } = fixture("self-example");
  const bound = b ? readyPrerequisite(details, "allCoordinates") : readyRepair(details, "allCoordinates");
  const explanation = buildSpanTargetedExplanation(attempt.spanExercise!, "allCoordinates")!;
  let snapshot = bound.session!;
  let failPause = true;
  mocks.request.mockImplementation(async (path: string, _schema: unknown, init?: RequestInit) => {
    if (!init) return { ...bound, session: snapshot };
    const input = JSON.parse(String(init.body));
    if (init.method === "PATCH") {
      if (input.status === "paused" && failPause) throw new Error("pause network failure");
      snapshot = { ...snapshot, ...input, revision: snapshot.revision + 1 }; return snapshot;
    }
    if (path.endsWith("/presentation")) return { problem: attempt.spanExercise, solution: solveSpanProblem(attempt.spanExercise!), targetedExplanation: explanation, exposureReceipt: { id: uuid() } };
    if (path.endsWith("/reserved")) return attempt;
    throw new Error(`unplanned repair request ${path}`);
  });
  mocks.read.mockResolvedValue({ observation: null, deliveredAssistance: "none" });
  const host = document.createElement("div"), root = createRoot(host);
  document.body.append(host);
  const click = async (text: string) => {
    const button = [...host.querySelectorAll("button")].find(row => row.textContent?.includes(text) || row.getAttribute("aria-label") === text);
    expect(button, text).toBeDefined(); await act(async () => button!.click());
  };
  try {
    await act(async () => root.render(<SpanLessonSession courseId={snapshot.courseId} sourceIds={snapshot.sourceIds} sourceLoadError={false} initialActivityId={snapshot.activityId} />));
    expect(host.textContent).toContain(explanation.brief);
    expect(host.textContent).toContain(b ? "只补这一个有依据的先修步骤，再返回原要求" : "外部先修关系与薄弱证据尚未确认");
    if (b) expect(host.textContent).not.toContain("外部先修关系与薄弱证据尚未确认");
    expect(host.textContent).not.toContain("span 是所有");
    expect([...host.querySelectorAll("button")].some(row => row.textContent === "授权或课程状态更新后，重新读取本节")).toBe(v2);
    expect(host.querySelector("[aria-label='span 学习目录']")).toBeNull();
    expect(mocks.createAttempt).not.toHaveBeenCalled(); expect(mocks.submitAttempt).not.toHaveBeenCalled();
    expect(mocks.request.mock.calls.some(call => call[2]?.method === "PATCH" || String(call[0]).endsWith("/next"))).toBe(false);
    const protocol = b ? { prerequisiteRepairVersion: 1 } : { repairVersion: 1 };
    expect(requestBodies("/presentation")).toEqual([{ activityId: snapshot.activityId, ...protocol, stage: "example", clientKey: `span-${b ? "prerequisite" : "repair"}:${snapshot.activityId}:v1:example` }]);
    if (v2) {
      await click("授权或课程状态更新后，重新读取本节");
      expect(mocks.request.mock.calls.filter(call => !call[2])).toHaveLength(2);
      expect(requestBodies("/presentation")).toHaveLength(2);
      expect(requestBodies("/presentation")[1]).toEqual(requestBodies("/presentation")[0]);
      expect(host.textContent).toContain(explanation.brief);
    }
    await click("开始做题");
    expect(snapshot.moveId).toBe("self-faded");
    expect(mocks.hint).not.toHaveBeenCalled();
    expect(requestBodies("/reserved")[0]).toMatchObject({ activityId: snapshot.activityId, ...protocol, stage: "variant", expectedRevision: snapshot.revision });
    expect(requestBodies("/reserved")[0]).not.toHaveProperty("sourceId");
    await click("更多"); await click("暂停并保存");
    expect(host.textContent).toContain("暂停还没保存"); expect(snapshot.status).toBe("active");
    failPause = false;
    await click("更多"); await click("暂停并保存");
    expect(snapshot.status).toBe("paused"); expect(snapshot.moveId).toBe("self-faded"); expect(snapshot.intent).toEqual(bound.session!.intent);
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it.each([true, false])("keeps clarification read-only in V2=%s until an explicit pause", async v2 => {
  mocks.v2 = v2;
  const { details } = fixture("self-example");
  const clarify = { ...details, repair: { status: "needs_clarification", version: 1, reasonCode: "predecessor_unobserved", message: "请补写原向量等式", prerequisiteStatus: "unknown" } };
  mocks.request.mockResolvedValue(clarify);
  const host = document.createElement("div"), root = createRoot(host); document.body.append(host);
  try {
    await act(async () => root.render(<SpanLessonSession courseId={details.session!.courseId} sourceIds={details.session!.sourceIds} sourceLoadError={false} initialActivityId={details.session!.activityId} />));
    expect(host.textContent).toContain("请补写原向量等式"); expect(host.textContent).toContain("尚未定位可信");
    expect(host.textContent).not.toContain("span 是所有"); expect(host.querySelector("select")).toBeNull();
    expect(mocks.request.mock.calls.every(call => !call[2])).toBe(true);
    expect(mocks.createAttempt).not.toHaveBeenCalled(); expect(mocks.submitAttempt).not.toHaveBeenCalled(); expect(mocks.hint).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it.each(["equation", "coefficients", "allCoordinates"] as const)("renders only the current server-released %s repair fragment", async target => {
  const { details, attempt } = fixture("self-example"), bound = readyRepair(details, target);
  const explanation = buildSpanTargetedExplanation(attempt.spanExercise!, target)!;
  mocks.request.mockResolvedValue({ problem: attempt.spanExercise, solution: solveSpanProblem(attempt.spanExercise!), targetedExplanation: explanation, exposureReceipt: { id: uuid() } });
  const save = vi.fn(async () => true), port = createSpanStudySession(bound, save), view = await port.load();
  expect(view.step.kind).toBe("learn");
  if (view.step.kind !== "learn") throw new Error("expected short lesson");
  expect(view.step.body).toContain(explanation.brief);
  for (const step of explanation.workedSteps) expect(view.step.body).toContain(step.math);
  expect(view.step.body).not.toContain("span 是所有"); expect(save).not.toHaveBeenCalled();
  await port.primary(); expect(save).toHaveBeenCalledExactlyOnceWith(bound.session!.intent, "self-faded", "active");
});

it.each([false, true])("blocks clarification and unavailable/mismatched content without generic fallback B=%s", async b => {
  const { details, attempt } = fixture("self-example");
  const save = vi.fn(async () => true);
  const clarify = { ...details, repair: { status: "needs_clarification", version: 1, reasonCode: "predecessor_unobserved", message: "请补写原向量等式", prerequisiteStatus: "unknown" } } as SpanLessonDetails;
  const clarification = createSpanStudySession(clarify, save);
  expect((await clarification.load()).blocked).toContain("尚未定位可信");
  await clarification.primary(); expect(mocks.request).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
  await clarification.pause(); expect(save).toHaveBeenCalledExactlyOnceWith(details.session!.intent, details.session!.moveId, "paused");
  for (const response of [null, { problem: attempt.spanExercise, solution: solveSpanProblem(attempt.spanExercise!), exposureReceipt: { id: uuid() } },
    { problem: attempt.spanExercise, solution: solveSpanProblem(attempt.spanExercise!), targetedExplanation: buildSpanTargetedExplanation(attempt.spanExercise!, "coefficients"), exposureReceipt: { id: uuid() } }]) {
    mocks.request.mockImplementation(async () => { if (!response) throw new Error("stale plan"); return response; });
    const port = createSpanStudySession(b ? readyPrerequisite(details) : readyRepair(details), save), view = await port.load();
    expect(view.blocked).toBeTruthy(); expect(view.step.kind === "learn" && view.step.body).not.toContain("span 是所有");
    await port.primary();
  }
  expect(save).toHaveBeenCalledTimes(1);
});

it.each([false, true])("restores exact variant/draft/help and explicit retry without overwriting first answer B=%s", async b => {
  const { details, attempt } = fixture(), bound = b ? readyPrerequisite(details, "coefficients") : readyRepair(details, "coefficients");
  const retry = { ...attempt, id: uuid(), historyRevision: 2 };
  let current = attempt;
  const records = new Map<string, LearningObservation>();
  mocks.request.mockImplementation(async (path: string, _schema: unknown, init: RequestInit) => {
    expect(path.endsWith("/reserved")).toBe(true);
    const input = JSON.parse(String(init.body));
    if (input.retryAfterAttemptId) { expect(input.retryAfterAttemptId).toBe(attempt.id); current = retry; }
    return current;
  });
  mocks.read.mockImplementation(async (_client, _course, row) => ({ observation: records.get(row.id) ?? null, deliveredAssistance: row.id === retry.id ? "revealed" : "hinted" }));
  mocks.hint.mockImplementation(async (_attempt, level) => hintResponse(level));
  const exact = (id: string, answer: string, correct: boolean) => ({ id: uuid(), attemptId: id, answer, assistance: id === retry.id ? "revealed" : "hinted",
    serverEvaluation: { evaluatorVersion: "span-exact-v1", attemptId: id, itemVersionId: attempt.itemVersionId, problemId: attempt.problemId,
      decision: correct ? "correct" : "incorrect", coreEvidenceComplete: correct, reasonCodes: [] } } as unknown as LearningObservation);
  mocks.submitAttempt.mockImplementation(async (id, input) => {
    const verified = verifySpanAnswer(attempt.spanExercise!, input.answer), row = exact(id, input.answer, verified.outcome === "correct" && verified.coreEvidenceComplete);
    records.set(id, row); return row;
  });
  const save = vi.fn(async () => true), port = createSpanStudySession(bound, save);
  await port.load(); port.edit({ membership: "in_span", coefficients: ["9", "9"] });
  expect(mocks.hint).not.toHaveBeenCalled();
  const loaded = await createSpanStudySession(bound, save).load(); expect(loaded.answer.coefficients).toEqual(["9", "9"]);
  expect(mocks.submitAttempt).not.toHaveBeenCalled();
  await port.primary(); const first = structuredClone(records.get(attempt.id));
  await expect(port.primary()).rejects.toThrow("显式选择改这道题"); expect(save).not.toHaveBeenCalled();
  await port.redo!(); expect(port.current!()).toBeNull();
  expect(mocks.createAttempt).not.toHaveBeenCalled();
  const p = retry.spanExercise!, solution = solveSpanProblem(p); if (solution.kind !== "unique") throw new Error("fixture");
  port.edit({ membership: "in_span", coefficients: solution.coefficients, equation: { vectors: p.vectors, target: p.target }, coordinateChecks: p.target });
  const result = await port.primary(); expect(result.result).toMatchObject({ outcome: "correct", assistance: "revealed" });
  expect(primaryAction(result, false).label).toBe(b ? "发放新题确认" : "看下一步安排");
  if (b) {
    expect(requestBodies("/reserved")).toContainEqual({ activityId: details.session!.activityId, prerequisiteRepairVersion: 1,
      expectedRevision: details.session!.revision, stage: "variant", clientKey: `span-prerequisite:${details.session!.activityId}:v1:retry:${attempt.id}`, retryAfterAttemptId: attempt.id });
    expect(requestBodies("/reserved").every(input => !input.repairVersion && !input.returnToRequirementId)).toBe(true);
  }
  expect(mocks.submitAttempt.mock.lastCall![1].assistance).toBe("revealed"); expect(records.get(attempt.id)).toEqual(first);
  const scopes = Object.keys(sessionStorage).filter(key => key.startsWith("opening-practice:v2:"));
  expect(JSON.parse(sessionStorage.getItem(scopes[0]!)!).drafts).toHaveLength(2);
  await port.primary(); expect(save).toHaveBeenCalledExactlyOnceWith(details.session!.intent, "self_study-reserved", "active");
  const resumed = await createSpanStudySession(bound, save).load(); expect(resumed.step.id).toBe(retry.id); expect(resumed.result?.assistance).toBe("revealed");
  expect(mocks.request.mock.calls.some(call => String(call[0]).endsWith("/next") || String(call[0]).endsWith("/session"))).toBe(false);
});

it.each([false, true])("restores only delivered bounded hint levels attached to current attempt B=%s", async b => {
  const { details, attempt } = fixture();
  const bound = { ...(b ? readyPrerequisite(details) : readyRepair(details)), hintLevels: { [attempt.id]: [1, 3] as (1 | 3)[] } };
  mocks.request.mockResolvedValue(attempt);
  mocks.read.mockResolvedValue({ observation: null, deliveredAssistance: "hinted" });
  mocks.hint.mockImplementation(async (_attempt, level) => hintResponse(level));
  const save = vi.fn(async () => false), port = createSpanStudySession(bound, save);
  const view = await port.load();
  expect(mocks.hint.mock.calls.map(call => [call[0].id, call[1]])).toEqual([[attempt.id, 1], [attempt.id, 3]]);
  expect(view.help).toMatchObject({ level: "hinted", hints: [{ level: 1 }, { level: 3 }] });
  port.edit({ membership: "in_span", coefficients: ["3", "4"] });
  await expect(port.pause()).rejects.toThrow("暂停还没保存");
  const resumed = await createSpanStudySession(bound, save).load();
  expect(resumed.step.id).toBe(attempt.id); expect(resumed.answer.coefficients).toEqual(["3", "4"]); expect(resumed.help.level).toBe("hinted");
  expect(mocks.submitAttempt).not.toHaveBeenCalled();
});

it.each([false, true])("preserves draft on stale stage and rejects incomplete/mismatched confirmation B=%s", async b => {
  const { details, attempt } = fixture("self_study-reserved"), bound = b ? readyPrerequisite(details) : readyRepair(details);
  mocks.request.mockResolvedValue(attempt); mocks.read.mockResolvedValue({ observation: null, deliveredAssistance: "none" });
  const port = createSpanStudySession(bound, vi.fn());
  await port.load(); port.edit({ membership: "in_span", coefficients: ["7", "8"] });
  const original = Object.fromEntries(Object.keys(sessionStorage).map(key => [key, sessionStorage.getItem(key)]));
  mocks.request.mockRejectedValueOnce(new Error("stage CAS changed"));
  const unavailable = await createSpanStudySession(bound, vi.fn()).load(); expect(unavailable.blocked).toContain("stage CAS changed");
  expect(Object.fromEntries(Object.keys(sessionStorage).map(key => [key, sessionStorage.getItem(key)]))).toEqual(original);
  for (const patch of [{ coreEvidenceComplete: false }, { itemVersionId: uuid() }, { attemptId: uuid() }]) {
    mocks.request.mockResolvedValue(attempt);
    mocks.read.mockResolvedValue({ observation: { id: uuid(), assistance: "revealed", serverEvaluation: { evaluatorVersion: "span-exact-v1", decision: "correct",
      attemptId: attempt.id, itemVersionId: attempt.itemVersionId, problemId: attempt.problemId, coreEvidenceComplete: true, reasonCodes: [], ...patch } }, deliveredAssistance: "hinted" });
    const view = await createSpanStudySession(bound, vi.fn()).load();
    expect(view.result).toMatchObject({ outcome: "unknown", assistance: "revealed" });
    expect(view.result?.detail).toContain("本次新题确认：证据不足");
  }
  expect(mocks.submitAttempt).not.toHaveBeenCalled();
});

it.each(["independent", "hinted", "revealed"] as const)("shows only current confirmation result with actual %s help and does not auto-next", async assistance => {
  const { details, attempt } = fixture("self_study-reserved"), bound = readyRepair(details);
  const record = { id: uuid(), attemptId: attempt.id, assistance, serverEvaluation: { evaluatorVersion: "span-exact-v1", decision: "correct", coreEvidenceComplete: true,
    attemptId: attempt.id, itemVersionId: attempt.itemVersionId, problemId: attempt.problemId, reasonCodes: [] } } as unknown as LearningObservation;
  mocks.request.mockResolvedValue(attempt); mocks.read.mockResolvedValue({ observation: record, deliveredAssistance: assistance === "independent" ? "none" : assistance });
  const save = vi.fn(async () => true), port = createSpanStudySession(bound, save), ui = await mount(port);
  try {
    expect(ui.host.textContent).toContain("本次新题确认：答案正确");
    expect(ui.host.textContent).toContain(assistance === "independent" ? "未使用帮助" : assistance === "hinted" ? "使用过提示" : "看过完整示范");
    expect(ui.host.textContent).toContain("不代表已掌握或外部先修已修复");
    expect(save).not.toHaveBeenCalled(); expect(mocks.submitAttempt).not.toHaveBeenCalled();
    expect(requestBodies("/reserved")[0]).toMatchObject({ stage: "confirmation", expectedRevision: details.session!.revision });
    expect(mocks.request.mock.calls.some(call => String(call[0]).endsWith("/next"))).toBe(false);
  } finally { await ui.unmount(); }
});


it.each(["correct", "incorrect"] as const)("returns explicitly from actual B confirmation %s with strict identity and no extra remediation", async outcome => {
  const { details, attempt } = fixture("self_study-reserved"), bound = readyPrerequisite(details);
  const record = { id: uuid(), attemptId: attempt.id, answer: "saved original answer", assistance: "hinted",
    serverEvaluation: { evaluatorVersion: "span-exact-v1", decision: outcome, coreEvidenceComplete: true,
      attemptId: attempt.id, itemVersionId: attempt.itemVersionId, problemId: attempt.problemId, reasonCodes: [] } } as unknown as LearningObservation;
  const target = uuid(), returned = { kind: "ready", activityId: target, courseId: details.session!.courseId,
    href: `/opening/courses/${details.session!.courseId}/study?activity=${target}`, label: "返回原要求", resumed: false };
  mocks.request.mockImplementation(async (path: string) => path.endsWith("/reserved") ? attempt : returned);
  mocks.read.mockResolvedValue({ observation: record, deliveredAssistance: "hinted" });
  const save = vi.fn(async () => true), port = createSpanStudySession(bound, save), ui = await mount(port);
  try {
    expect(ui.host.textContent).toContain(outcome === "correct" ? "答案正确" : "尚未正确");
    expect(ui.host.textContent).toContain("使用过提示"); expect(ui.host.textContent).toContain("不代表先修已修复或已经掌握");
    expect(ui.host.querySelector("[data-primary-action]")?.textContent).toBe("返回原要求");
    expect(port.changeExplanation).toBeUndefined(); expect(requestBodies("/next")).toEqual([]); expect(save).not.toHaveBeenCalled();
    const refreshed = await createSpanStudySession(bound, save).load();
    expect(refreshed.step.id).toBe(attempt.id); expect(refreshed.result).toMatchObject({ outcome, assistance: "hinted" });
    await ui.click("返回原要求");
    expect(requestBodies("/next")).toEqual([{ activityId: details.session!.activityId, prerequisiteRepairVersion: 1,
      expectedRevision: details.session!.revision, observationId: record.id, clientKey: `span-prerequisite-return:${details.session!.activityId}:${record.id}` }]);
    expect(mocks.push).not.toHaveBeenCalled();
    await ui.click("返回原要求");
    expect(mocks.push).toHaveBeenCalledExactlyOnceWith(returned.href);
    expect(requestBodies("/next")).toHaveLength(1);
    expect(record.answer).toBe("saved original answer"); expect(save).not.toHaveBeenCalled();
    expect(mocks.createAttempt).not.toHaveBeenCalled(); expect(mocks.submitAttempt).not.toHaveBeenCalled();
  } finally { await ui.unmount(); }
});

it.each(["abstain", "retracted", "incomplete", "foreign-item"])("never returns or generically falls back for B %s confirmation", async fault => {
  const { details, attempt } = fixture("self_study-reserved"), bound = readyPrerequisite(details);
  mocks.request.mockResolvedValue(attempt);
  mocks.read.mockResolvedValue({ observation: { id: uuid(), attemptId: attempt.id, assistance: "independent",
    revisionKind: fault === "retracted" ? "retract" : undefined,
    serverEvaluation: fault === "retracted" ? null : { evaluatorVersion: "span-exact-v1", decision: fault === "abstain" ? "abstain" : "correct",
      coreEvidenceComplete: fault !== "incomplete", attemptId: attempt.id, itemVersionId: fault === "foreign-item" ? uuid() : attempt.itemVersionId, problemId: attempt.problemId, reasonCodes: [] } }, deliveredAssistance: "none" });
  const save = vi.fn(), port = createSpanStudySession(bound, save), view = await port.load();
  expect(view.result?.outcome).toBe("unknown"); expect(view.blocked).toBeTruthy();
  expect(primaryAction(view, false)).toMatchObject({ kind: "none", disabled: true });
  await port.primary(); expect(requestBodies("/next")).toEqual([]); expect(save).not.toHaveBeenCalled();
  expect(mocks.createAttempt).not.toHaveBeenCalled(); expect(port.changeExplanation).toBeUndefined();
});


it.each([true, false])("keeps unavailable B history read-only in V2=%s and permits only explicit original pause", async v2 => {
  mocks.v2 = v2;
  const { details, attempt } = fixture("self-faded");
  const record = { id: uuid(), skillLabel: "原作答", answer: "保留的原始错误答案" } as LearningObservation;
  let snapshot = details.session!;
  mocks.request.mockImplementation(async (_path: string, _schema: unknown, init?: RequestInit) => {
    if (!init) return { ...details, session: snapshot, attempts: [attempt], observations: [record], executionUnavailable: { reasonCode: "SPAN_PREREQUISITE_EVIDENCE_CHANGED", message: "原先修证据已变化" } };
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ expectedRevision: snapshot.revision, intent: snapshot.intent, moveId: snapshot.moveId, status: "paused" });
    snapshot = { ...snapshot, status: "paused", revision: snapshot.revision + 1 }; return snapshot;
  });
  const host = document.createElement("div"), root = createRoot(host); document.body.append(host);
  const click = async (text: string) => { const node = [...host.querySelectorAll("button")].find(row => row.textContent === text); expect(node).toBeDefined(); await act(async () => node!.click()); };
  try {
    await act(async () => root.render(<SpanLessonSession courseId={snapshot.courseId} sourceIds={snapshot.sourceIds} sourceLoadError={false} initialActivityId={snapshot.activityId} />));
    expect(host.textContent).toContain("原先修证据已变化"); expect(host.querySelector("select, input, [data-primary-action]")).toBeNull();
    expect(host.textContent).not.toContain("授权或课程状态更新后，重新读取本节");
    await click("查看原活动历史"); expect(host.textContent).toContain(record.answer); expect(host.textContent).toContain("只读");
    expect(mocks.request).toHaveBeenCalledTimes(1);
    await click("返回重新选择"); await click("暂停并保留记录");
    expect(host.textContent).toContain("本次学习已暂停，原记录保留");
    expect([...host.querySelectorAll("button")].some(row => row.textContent?.includes("继续原来的步骤"))).toBe(false);
    expect(mocks.createAttempt).not.toHaveBeenCalled(); expect(mocks.submitAttempt).not.toHaveBeenCalled(); expect(mocks.hint).not.toHaveBeenCalled();
    expect(requestBodies("/presentation")).toEqual([]); expect(requestBodies("/reserved")).toEqual([]); expect(requestBodies("/next")).toEqual([]);
  } finally { await act(async () => root.unmount()); host.remove(); }
});


it.each(["abstain", "incomplete", "foreign-item"])("requires exact complete B variant before issuing confirmation: %s", async fault => {
  const { details, attempt } = fixture("self-faded"), bound = readyPrerequisite(details);
  mocks.request.mockResolvedValue(attempt);
  mocks.read.mockResolvedValue({ observation: { id: uuid(), attemptId: attempt.id, assistance: "independent",
    serverEvaluation: { evaluatorVersion: "span-exact-v1", decision: fault === "abstain" ? "abstain" : "correct", coreEvidenceComplete: fault !== "incomplete",
      attemptId: attempt.id, itemVersionId: fault === "foreign-item" ? uuid() : attempt.itemVersionId, problemId: attempt.problemId, reasonCodes: [] } }, deliveredAssistance: "none" });
  const save = vi.fn(), port = createSpanStudySession(bound, save), view = await port.load();
  expect(view.result?.outcome).toBe("unknown"); expect(primaryAction(view, false).label).not.toBe("发放新题确认");
  await expect(port.primary()).rejects.toThrow("显式选择改这道题");
  expect(save).not.toHaveBeenCalled(); expect(requestBodies("/reserved").map(input => input.stage)).toEqual(["variant"]);
});

it("adopts only the server's current B retry on refresh while retaining the original sealed answer and help", async () => {
  const { details, attempt } = fixture("self-faded"), bound = readyPrerequisite(details);
  const wrong = { id: uuid(), attemptId: attempt.id, answer: JSON.stringify({ membership: "in_span", coefficients: ["9", "9"] }), assistance: "hinted",
    serverEvaluation: { evaluatorVersion: "span-exact-v1", decision: "incorrect", attemptId: attempt.id, itemVersionId: attempt.itemVersionId, problemId: attempt.problemId, reasonCodes: [] } } as unknown as LearningObservation;
  mocks.request.mockResolvedValue(attempt); mocks.read.mockResolvedValue({ observation: null, deliveredAssistance: "hinted" });
  mocks.submitAttempt.mockResolvedValue(wrong);
  const port = createSpanStudySession(bound, vi.fn()); await port.load(); port.edit({ membership: "in_span", coefficients: ["9", "9"] });
  mocks.read.mockResolvedValue({ observation: wrong, deliveredAssistance: "hinted" }); await port.primary();
  const firstInput = structuredClone(mocks.submitAttempt.mock.calls[0]![1]);
  const retry = { ...attempt, id: uuid(), historyRevision: 2 };
  // Another tab has explicitly authorized the current retry; no client chooser reconstructs it.
  mocks.request.mockResolvedValue(retry); mocks.read.mockResolvedValue({ observation: null, deliveredAssistance: "hinted" });
  const view = await createSpanStudySession(bound, vi.fn()).load();
  expect(view.step.id).toBe(retry.id); expect(view.sealed).toBe(false); expect(view.result).toBeNull(); expect(view.help.level).toBe("hinted");
  expect(mocks.submitAttempt).toHaveBeenCalledTimes(1);
  const collections = Object.keys(sessionStorage).filter(key => key.startsWith("opening-practice:v2:")).map(key => JSON.parse(sessionStorage.getItem(key)!));
  const original = collections.flatMap(collection => collection.drafts).find(row => row.attemptId === attempt.id);
  expect(original).toMatchObject({ observationId: wrong.id, submission: { input: firstInput } });
  expect(mocks.createAttempt).not.toHaveBeenCalled(); expect(mocks.hint).not.toHaveBeenCalled();
});

it.each(["choice", "error", "foreign", "ordinary-session"])("retains B confirmation facts and position after return %s without generic fallback", async failure => {
  const { details, attempt } = fixture("self_study-reserved"), bound = readyPrerequisite(details);
  const record = { id: uuid(), attemptId: attempt.id, answer: "original confirmation answer", assistance: "revealed",
    serverEvaluation: { evaluatorVersion: "span-exact-v1", decision: "incorrect", attemptId: attempt.id, itemVersionId: attempt.itemVersionId, problemId: attempt.problemId, reasonCodes: [] } } as unknown as LearningObservation;
  mocks.request.mockImplementation(async (path: string) => {
    if (path.endsWith("/reserved")) return attempt;
    if (failure === "error") throw new Error("return basis changed");
    if (failure === "ordinary-session") {
      const activityId = uuid();
      return { kind: "ready", activityId, courseId: details.session!.courseId, sessionId: uuid(), resumed: false,
        label: "普通新课", href: `/opening/courses/${details.session!.courseId}/study/span?lesson=${activityId}` };
    }
    return { kind: "choice", reason: "evidence_changed", message: "依据变化，原记录保留", primary: { label: "核对记录",
      href: `/opening/courses/${failure === "foreign" ? uuid() : details.session!.courseId}#course-learning-records` } };
  });
  mocks.read.mockResolvedValue({ observation: record, deliveredAssistance: "revealed" });
  const save = vi.fn(), port = createSpanStudySession(bound, save), view = await port.load();
  if (failure === "choice") {
    const result = await port.primary();
    expect(result.step.id).toBe(attempt.id); expect(result.result).toMatchObject({ outcome: "incorrect", assistance: "revealed" });
    expect(result.next).toMatchObject({ choiceReason: "evidence_changed", notice: "依据变化，原记录保留" });
    expect(result.next?.href).not.toContain("mode=practice");
  } else await expect(port.primary()).rejects.toThrow();
  expect(view.step.id).toBe(attempt.id); expect(record.answer).toBe("original confirmation answer"); expect(save).not.toHaveBeenCalled();
  expect(mocks.createAttempt).not.toHaveBeenCalled(); expect(mocks.submitAttempt).not.toHaveBeenCalled(); expect(port.changeExplanation).toBeUndefined();
});
