// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LearningAttempt } from "@aistudy/contracts";
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
  await act(async () => action()!.click()); expect(bodies).toHaveLength(2); expect(bodies[1]).toEqual(bodies[0]);
  await act(async () => root.render(null)); await render(); expect(bodies).toHaveLength(2);
  expect(action()!.disabled).toBe(true); await act(async () => action()!.click()); expect(bodies).toHaveLength(2);
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
