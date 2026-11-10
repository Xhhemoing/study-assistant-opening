// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { turnInputSchema, type LearningAttempt, type ProviderInput } from "@aistudy/contracts";
import type { OpeningTutorJobsRepository, TutorAttemptContext } from "@aistudy/database";
import { createTutorTurnHandler, type TutorTurnDeps } from "../../../../../worker/src/jobs/tutor-turn";
import { learningObservation } from "../../../../../../packages/domain/src/opening/learning-summary-fixtures";
import { publishVerifiedSessionIdentity } from "../../auth/session-identity";
import { clearSessionExpiry } from "../../auth/session-expiry";
import { createOpeningApi, type OpeningApi } from "../client/api";
import { AssistantView } from "./assistant-view";
import { GRADED_ATTEMPT_EXPLANATION_TEXT } from "./graded-attempt-explanation";

vi.mock("../capabilities/capabilities-provider", async () => { const { CLOSED_CAPABILITIES } = await import("@aistudy/config/public"); return { useOpeningCapabilities: () => CLOSED_CAPABILITIES }; });
vi.mock("../library/material-organization-client", () => ({ createMaterialOrganizationClient: () => ({ read: async () => ({ courses: [], memberships: [] }) }) }));
vi.mock("../teaching/learner-state-card", () => ({ LearnerStateCard: () => null }));
vi.mock("./proposal-panel", () => ({ ProposalPanel: () => null }));
const id = "11111111-1111-4111-8111-111111111111", sessionId = "22222222-2222-4222-8222-222222222222";
const item = "33333333-3333-4333-8333-333333333333", conversationId = "44444444-4444-4444-8444-444444444444";
const identity = { id: "owner", workspaceId: id };
const attempt: LearningAttempt = { id, sessionId, workspaceId: id, courseId: learningObservation.courseId, skillLabel: "导数", requirementKey: null,
  problemId: item, itemVersionId: item, sourceIds: [], sourceVersions: {}, startedAt: "2026-11-10T12:00:00Z", submittedAt: "2026-11-10T12:01:00Z",
  observationId: learningObservation.id, historyRevision: 1, contextAnchor: { courseId: learningObservation.courseId, attemptId: id, itemVersionId: item, activityId: sessionId, purpose: "learning_help" } };
const record = { ...learningObservation, attemptId: id, sessionId, problemId: item, itemVersionId: item, verdictSource: "ai_graded", outcome: "incorrect",
  aiEvaluation: { observationId: learningObservation.id, attemptId: id, problemId: item, itemVersionId: item, requirementKey: null,
    evaluatorVersion: "ai-rubric-v1", modelLabel: "test", evaluatedAt: "2026-11-10T12:01:00Z", outcome: "incorrect", confidence: 0.9,
    questionMatch: true, feedback: "错步反馈", criteria: [{ label: "列式", verdict: "incorrect", feedback: "待修正" }] } };
const initial = { rootObservationId: record.id, expectedHead: record.id, answerRevision: 1, privacyEpoch: 0, previousGradingVersion: 1, oldStatus: "graded" };
let snapshot: typeof initial, head: typeof record, cookieOwner: typeof identity;
let host: HTMLDivElement, root: Root, clearIdentity: () => void, api: OpeningApi;
let bodies: Record<string, unknown>[];
const transport = vi.fn<typeof fetch>();
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); clearSessionExpiry(); localStorage.clear(); sessionStorage.clear();
  snapshot = { ...initial }; head = structuredClone(record); cookieOwner = identity; bodies = [];
  clearIdentity = publishVerifiedSessionIdentity(identity);
  transport.mockReset(); transport.mockImplementation(async (path, init) => {
    const url = String(path);
    if (url === "/api/auth/me") return Response.json({ user: cookieOwner });
    if (url.includes("/observations/regrade?")) return Response.json({ snapshot });
    if (url.endsWith("/history")) return Response.json({ rootObservationId: record.id, headObservationId: head.id, revisions: [head] });
    if (url === "/api/opening/turns") { bodies.push(JSON.parse(String(init?.body))); throw Error("lost response"); }
    return Response.json({ error: { message: "not found" } }, { status: 404 });
  });
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request: vi.fn(async (_name, _options, action) => action({ name: _name })) } });
  vi.stubGlobal("fetch", transport);
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  api = { ...createOpeningApi(transport), listSources: vi.fn(async () => []), listTutorActions: vi.fn(async () => []),
    createConversation: vi.fn(async () => ({ id: conversationId, title: "学习对话", courseId: attempt.courseId })) };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); clearIdentity(); vi.unstubAllGlobals(); });
const render = (value = attempt, disabled = false) => act(async () => root.render(<AssistantView api={api} embedded startFresh learningAttempt={value} interactionDisabled={disabled} initialDraft="保留推导" />));
const action = () => [...host.querySelectorAll("button")].find(button => button.textContent === "讲解这次作答");
const posts = () => transport.mock.calls.filter(([, init]) => init?.method === "POST");

it("sends the complete native client body from a fresh empty session, once per click, retaining unknown keys and draft", async () => {
  await render(); expect(posts()).toHaveLength(0); expect(api.createConversation).not.toHaveBeenCalled();
  expect(action()).toBeDefined(); expect(host.textContent).toContain("讲清楚一步"); expect(host.textContent).not.toContain("讲细点");
  await act(async () => { action()!.click(); action()!.click(); });
  expect(api.createConversation).toHaveBeenCalledOnce(); expect(bodies).toHaveLength(1);
  expect(bodies[0]).toEqual({ conversationId, text: GRADED_ATTEMPT_EXPLANATION_TEXT, mode: "explain", purpose: "answer", privacy: "saved",
    clientKey: expect.any(String), sourceSelection: "auto", sourceIds: [], learningSessionId: sessionId, attemptId: id, contextAnchor: attempt.contextAnchor });
  expect(bodies[0]!.text).toBe("请讲解我这次作答：先说我最早错在哪一步和正确答案，只补这一步缺的知识，再给一道同类题让我自己做。");
  expect(host.querySelector("textarea")?.value).toBe("保留推导");
  await act(async () => action()!.click()); expect(bodies).toHaveLength(1);
  const receipt = JSON.parse(localStorage.getItem(Object.keys(localStorage).find(key => key.startsWith("opening:graded-attempt-explain:"))!)!);
  expect(receipt).toMatchObject({ clientKey: bodies[0]!.clientKey, conversationId, phase: "submitted", snapshot: initial });
  expect(Object.keys(receipt).sort()).toEqual(["binding", "clientKey", "conversationId", "owner", "phase", "snapshot", "version"]);
  await act(async () => root.render(null)); await render(); expect(bodies).toHaveLength(1);
  expect(action()!.disabled).toBe(true); await act(async () => action()!.click()); expect(bodies).toHaveLength(1);
});
it("carries the fresh-session native button request through the actual worker envelope without client answer text", async () => {
  await render(); await act(async () => action()!.click());
  const request = turnInputSchema.parse(bodies[0]);
  expect(request).toMatchObject({ text: GRADED_ATTEMPT_EXPLANATION_TEXT, mode: "explain", purpose: "answer",
    sourceSelection: "auto", sourceIds: [], learningSessionId: sessionId, attemptId: id, contextAnchor: attempt.contextAnchor });
  expect(request).not.toHaveProperty("answer"); expect(request).not.toHaveProperty("aiEvaluation");
  const context: TutorAttemptContext = { privacyEpoch: 0, anchor: attempt.contextAnchor!, originalQuestion: "Saved server question",
    originalAnswer: { observationId: record.id, answer: "Saved server answer", answerRevision: 1 },
    currentAnswer: { observationId: record.id, answer: "Saved server answer", answerRevision: 1 },
    rootObservationId: record.id, headObservationId: record.id, workSource: null, sourceRefs: [],
    effectiveGrading: { observationId: record.id, answerRevision: 1, outcome: "incorrect", verdictSource: "ai_graded", aiEvaluation: null, serverEvaluation: null } };
  // Repository doubles stand in only for persisted identities; the native request and worker are real.
  const jobs = { get: vi.fn(async () => ({ workspaceId: id, ownerUserId: identity.id })),
    claim: vi.fn(async () => ({ id: item, workspaceId: id, ownerUserId: identity.id, conversationId, userTurnId: sessionId, assistantTurnId: item, mode: request.mode })),
    getUserTurn: vi.fn(async () => ({ ...request, sourceVersions: {} })),
    freezeHelpInputSnapshot: vi.fn(async () => ({ userTurnId: sessionId, assistantTurnId: item, tutorMode: request.mode, studyIntent: null })),
    readAttemptContext: vi.fn(async () => context), assertAttemptContext: vi.fn(async () => {}),
    loadHistoryContext: vi.fn(async () => ({ history: [], sourceRefs: [] })), completeTurn: vi.fn(async () => {}),
    fail: vi.fn(async () => {}), markUnknown: vi.fn(async () => {}) };
  const provider = { complete: vi.fn(async (_input: ProviderInput) => ({ text: "Original explanation", citedChunkIds: [], candidates: [], inputTokens: 1, outputTokens: 1, requestId: null })) };
  await createTutorTurnHandler({ tutorJobs: jobs as unknown as OpeningTutorJobsRepository,
    chunks: { listForSources: vi.fn(async () => []), listChunksAtVersion: vi.fn(async () => []) },
    budget: { reserve: vi.fn(async () => ({ id: "reservation" })), claimExecution: vi.fn(async () => true),
      release: vi.fn(async () => ({})), settle: vi.fn(async () => ({})), markUnknown: vi.fn(async () => ({})) } as unknown as TutorTurnDeps["budget"],
    provider, config: { maxContextCharacters: 5000, reservedCents: 1, maxOutputTokens: 256, inputCentsPerMillion: 1, outputCentsPerMillion: 1 },
  })(item);
  expect(jobs.readAttemptContext).toHaveBeenCalledWith({ workspaceId: id, ownerUserId: identity.id }, { userTurnId: sessionId, jobId: item, claimToken: undefined });
  expect(provider.complete).toHaveBeenCalledOnce();
  expect(JSON.parse(provider.complete.mock.calls[0]![0].text)).toMatchObject({ request: GRADED_ATTEMPT_EXPLANATION_TEXT,
    attemptContext: { originalQuestion: "Saved server question", originalAnswer: context.originalAnswer,
      currentAnswer: { observationId: record.id, answerRevision: 1, answerFrom: "originalAnswer" }, effectiveGrading: context.effectiveGrading } });
  expect(jobs.assertAttemptContext).toHaveBeenCalled(); expect(jobs.completeTurn).toHaveBeenCalledOnce();
});
it("recovers an accepted lost-response turn by GET after remount without another POST", async () => {
  const normal = transport.getMockImplementation()!;
  transport.mockImplementation(async (path, init) => {
    const url = String(path);
    if (url.endsWith("/resume")) return Response.json({ conversationId, courseId: attempt.courseId, sourceIds: [], boundedHistory: [], historyTruncated: false });
    if (url.endsWith("/turns") && init?.method === "GET") return Response.json([
      { id: sessionId, conversationId, role: "user", text: GRADED_ATTEMPT_EXPLANATION_TEXT, mode: "explain", status: "complete", contextAnchor: attempt.contextAnchor, citations: [], createdAt: "2026-11-10T12:01:00Z" },
      { id: item, conversationId, role: "assistant", text: "完整原始讲解结果，不截断", mode: "explain", status: "complete", contextAnchor: attempt.contextAnchor, citations: [], createdAt: "2026-11-10T12:02:00Z" },
    ]);
    if (url.endsWith("/pending-job")) return Response.json(null);
    return normal(path, init);
  });
  await render(); await act(async () => action()!.click()); expect(bodies).toHaveLength(1);
  await act(async () => root.render(null)); await render();
  expect(host.textContent).toContain("完整原始讲解结果，不截断");
  const recover = [...host.querySelectorAll("button")].find(button => button.textContent === "重新读取原讲解（不调用 AI）")!;
  await act(async () => recover.click());
  expect(host.textContent).toContain("完整原始讲解结果，不截断");
  expect(bodies).toHaveLength(1); expect(api.createConversation).toHaveBeenCalledOnce();
  snapshot.privacyEpoch += 1;
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(host.textContent).not.toContain("完整原始讲解结果，不截断"); expect(action()).toBeUndefined();
});
it("recovers a pending original job and then its complete turns using only real GET routes", async () => {
  const normal = transport.getMockImplementation()!;
  let complete = false;
  transport.mockImplementation(async (path, init) => {
    const url = String(path);
    if (url.endsWith("/resume")) return Response.json({ conversationId, courseId: attempt.courseId, sourceIds: [], boundedHistory: [], historyTruncated: false });
    if (url.endsWith("/turns") && init?.method === "GET") return Response.json([
      { id: sessionId, conversationId, role: "user", text: GRADED_ATTEMPT_EXPLANATION_TEXT, mode: "explain", status: "complete", contextAnchor: attempt.contextAnchor, citations: [], createdAt: "2026-11-10T12:01:00Z" },
      { id: item, conversationId, role: "assistant", text: complete ? "原任务完成后的全部结果" : "", mode: "explain", status: complete ? "complete" : "pending", contextAnchor: attempt.contextAnchor, citations: [], createdAt: "2026-11-10T12:02:00Z" },
    ]);
    if (url.endsWith("/pending-job")) return Response.json(complete ? null : { id: item, status: "running", error: null, updatedAt: "2026-11-10T12:02:00Z" });
    if (url === `/api/opening/jobs/${item}`) { complete = true; return Response.json({ id: item, status: "succeeded", error: null, updatedAt: "2026-11-10T12:03:00Z" }); }
    return normal(path, init);
  });
  await render(); await act(async () => action()!.click());
  await act(async () => root.render(null)); await render();
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(transport.mock.calls.some(([path]) => String(path) === `/api/opening/jobs/${item}`)).toBe(true);
  expect(host.textContent).toContain("原任务完成后的全部结果"); expect(bodies).toHaveLength(1);
});
it("does not blindly recreate a conversation after its create response is lost", async () => {
  api.createConversation = vi.fn(async () => { throw Error("lost create response"); });
  await render(); await act(async () => action()!.click());
  await act(async () => action()!.click());
  await act(async () => root.render(null)); await render();
  expect(api.createConversation).toHaveBeenCalledOnce(); expect(bodies).toHaveLength(0);
  expect(host.textContent).toContain("会话创建结果尚未确认");
});
it.each(["owner", "cookie", "epoch", "head"])("revokes recovered result on %s drift without POST or cross-owner receipt reads", async kind => {
  await render(); await act(async () => action()!.click());
  await act(async () => root.render(null));
  if (kind === "owner") { clearIdentity(); clearIdentity = publishVerifiedSessionIdentity({ ...identity, id: "other" }); }
  if (kind === "cookie") cookieOwner = { ...identity, id: "other" };
  if (kind === "epoch") snapshot.privacyEpoch += 1;
  if (kind === "head") snapshot.expectedHead = item;
  const storageRead = vi.spyOn(Storage.prototype, "getItem");
  await render();
  expect(action()).toBeUndefined(); expect(bodies).toHaveLength(1);
  if (kind === "owner" || kind === "cookie") expect(storageRead.mock.calls.some(([key]) => key.includes("graded-attempt-explain"))).toBe(false);
  storageRead.mockRestore();
});
it.each(["started", "partial", "malformed", "wrong-owner"])("rejects %s receipt without writes", async kind => {
  const key = `opening:graded-attempt-explain:${JSON.stringify([identity.id, identity.workspaceId])}:${attempt.courseId}:${attempt.id}`;
  if (kind === "started") sessionStorage.setItem(key, "started");
  else localStorage.setItem(key, kind === "partial" ? JSON.stringify({ version: 1, clientKey: "original-key" }) : kind === "malformed" ? "{broken" : JSON.stringify({ owner: "other" }));
  await render(); expect(action()).toBeUndefined(); expect(posts()).toHaveLength(0); expect(api.createConversation).not.toHaveBeenCalled();
});
it("a second mounted tab surface reads the same receipt and never allocates another key or conversation", async () => {
  await render(); await act(async () => action()!.click());
  const saved = localStorage.getItem(Object.keys(localStorage).find(key => key.includes("graded-attempt-explain"))!);
  const second = document.createElement("div"); document.body.append(second); const other = createRoot(second);
  try {
    await act(async () => other.render(<AssistantView api={api} embedded startFresh learningAttempt={attempt} />));
    const button = [...second.querySelectorAll("button")].find(button => button.textContent === "讲解这次作答")!;
    expect(button.disabled).toBe(true); await act(async () => button.click());
    expect(bodies).toHaveLength(1); expect(api.createConversation).toHaveBeenCalledOnce();
    expect(localStorage.getItem(Object.keys(localStorage).find(key => key.includes("graded-attempt-explain"))!)).toBe(saved);
  } finally { await act(async () => other.unmount()); second.remove(); }
});
it("serializes simultaneous first clicks from two surfaces using the shared browser lock", async () => {
  const active = new Set<string>();
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request: vi.fn(async (name: string, _options: unknown, callback: (lock: object | null) => Promise<void>) => {
    if (active.has(name)) return callback(null);
    active.add(name); try { return await callback({ name }); } finally { active.delete(name); }
  }) } });
  await render();
  const second = document.createElement("div"); document.body.append(second); const other = createRoot(second);
  try {
    await act(async () => other.render(<AssistantView api={api} embedded startFresh learningAttempt={attempt} />));
    const button = [...second.querySelectorAll("button")].find(button => button.textContent === "讲解这次作答")!;
    await act(async () => { action()!.click(); button.click(); });
    expect(bodies).toHaveLength(1); expect(api.createConversation).toHaveBeenCalledOnce();
  } finally { await act(async () => other.unmount()); second.remove(); }
});
it.each(["locks", "storage"])("does not send if %s cannot preserve safe ownership", async kind => {
  await render();
  const spy = kind === "storage" ? vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw Error("storage denied"); }) : null;
  if (kind === "locks") Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
  try { await act(async () => action()!.click()); expect(api.createConversation).not.toHaveBeenCalled(); expect(bodies).toHaveLength(0); }
  finally { spy?.mockRestore(); }
});
it("revokes the current surface when a different tab updates its operation", async () => {
  await render();
  const key = `opening:graded-attempt-explain:${JSON.stringify([identity.id, identity.workspaceId])}:${attempt.courseId}:${attempt.id}`;
  await act(async () => window.dispatchEvent(new StorageEvent("storage", { key })));
  expect(action()).toBeUndefined(); expect(posts()).toHaveLength(0);
});
it.each(["correct", "manual", "ungraded", "missing", "mismatch"])("has no executable action for %s", async kind => {
  if (kind === "correct") { head.outcome = "correct"; head.aiEvaluation.outcome = "correct"; }
  if (kind === "manual") head.verdictSource = "self_report";
  if (kind === "ungraded") snapshot.oldStatus = "needs_manual";
  if (kind === "mismatch") head.aiEvaluation.questionMatch = false;
  await render(kind === "missing" ? { ...attempt, itemVersionId: null } : attempt);
  expect(action()).toBeUndefined(); expect(posts()).toHaveLength(0);
});
it.each(["namespace", "cookie", "head", "epoch", "status"])("fails closed before any write on %s changes", async kind => {
  await render(); const button = action()!;
  if (kind === "namespace") { clearIdentity(); clearIdentity = publishVerifiedSessionIdentity({ ...identity, id: "other" }); }
  if (kind === "cookie") cookieOwner = { ...identity, id: "other" };
  if (kind === "head") snapshot.expectedHead = item;
  if (kind === "epoch") snapshot.privacyEpoch += 1;
  if (kind === "status") snapshot.oldStatus = "unknown_cost";
  await act(async () => button.click()); expect(posts()).toHaveLength(0); expect(api.createConversation).not.toHaveBeenCalled();
});
it("fences a late conversation creation after an owner switch", async () => {
  let finish!: () => void;
  api.createConversation = vi.fn<OpeningApi["createConversation"]>(() => new Promise(resolve => { finish = () => resolve({ id: conversationId, title: "学习对话", courseId: attempt.courseId }); }));
  await render(); await act(async () => action()!.click());
  clearIdentity(); clearIdentity = publishVerifiedSessionIdentity({ ...identity, id: "other" });
  await act(async () => finish()); expect(bodies).toHaveLength(0);
});
it("does not create a new paid request after an accepted turn", async () => {
  api.submitTurn = vi.fn(async () => ({ jobId: item, turnId: id }));
  api.resumeConversation = vi.fn(async () => ({ conversationId, courseId: attempt.courseId, sourceIds: [], boundedHistory: [], historyTruncated: false }));
  api.listTurns = vi.fn(async () => []);
  api.getPendingJob = vi.fn(async () => null);
  api.getJob = vi.fn<OpeningApi["getJob"]>(async () => ({ id: item, status: "succeeded", error: null, updatedAt: "2026-11-10T12:01:00Z" }));
  await render(); await act(async () => action()!.click());
  expect(api.submitTurn).toHaveBeenCalledOnce(); expect(action()!.disabled).toBe(true);
  await act(async () => action()!.click()); expect(api.submitTurn).toHaveBeenCalledOnce();
});
it("does not send after the bound item/head changes during conversation creation", async () => {
  let finish!: () => void;
  api.createConversation = vi.fn<OpeningApi["createConversation"]>(() => new Promise(resolve => { finish = () => resolve({ id: conversationId, title: "学习对话", courseId: attempt.courseId }); }));
  await render(); await act(async () => action()!.click());
  await render({ ...attempt, itemVersionId: sessionId, observationId: item });
  await act(async () => finish()); expect(bodies).toHaveLength(0);
});
it("honors disabled host state and has no mount/reload POST", async () => {
  await render(attempt, true); expect(action()!.disabled).toBe(true); await act(async () => action()!.click());
  await act(async () => root.render(null)); await render(); expect(posts()).toHaveLength(0);
});
