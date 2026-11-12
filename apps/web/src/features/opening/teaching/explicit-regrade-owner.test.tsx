// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EXPLICIT_REGRADE_CONFIRMATION_TEXT, EXPLICIT_REGRADE_CONFIRMATION_VERSION, type ExplicitRegradeRequest } from "@aistudy/contracts";
import { getVerifiedSessionNamespace, publishVerifiedSessionIdentity } from "../../auth/session-identity";
import { clearSessionExpiry } from "../../auth/session-expiry";
import { ExplicitRegradeHttpOwner } from "./explicit-regrade-owner";
import { createExplicitRegradeHttp } from "./explicit-regrade-http";

vi.mock("../design/ui", () => ({ ui: { primary: "primary", secondary: "secondary" } }));
const id = "11111111-1111-4111-8111-111111111111", rid = "22222222-2222-4222-8222-222222222222", job = "33333333-3333-4333-8333-333333333333";
const initial = { rootObservationId: id, expectedHead: id, answerRevision: 1, privacyEpoch: 0, previousGradingVersion: 0, oldStatus: "unknown_cost" as const };
const request: ExplicitRegradeRequest = { requestId: rid, rootObservationId: id, expectedHead: id, answerRevision: 1, privacyEpoch: 0,
  previousGradingVersion: 0, gradingVersion: 1, previousOperationId: "old-op", operationId: "new-op", state: "prepared", confirmedAt: null,
  confirmationVersion: EXPLICIT_REGRADE_CONFIRMATION_VERSION, confirmationText: EXPLICIT_REGRADE_CONFIRMATION_TEXT,
  workSource: { id: job, version: 2, physicalPage: 3 }, jobId: null, resultObservationId: null };
const prepared = () => ({ kind: "prepared", request, estimateCents: 7, estimate: "真实预算 ¥0.07", snapshot: initial });
function progress(status: "queued" | "grading" | "graded" | "needs_manual" | "unknown_cost" | null) {
  return { kind: "progress", progress: { request: { ...request, state: "confirmed", confirmedAt: "2026-11-10T12:00:00.000Z",
    jobId: status ? job : null, resultObservationId: status === "graded" || status === "needs_manual" ? rid : null },
  status: status ? { rootObservationId: id, headObservationId: status === "graded" ? rid : id, answerRevision: 1,
    status, retryable: false, jobId: job, workSource: request.workSource } : null },
  snapshot: { ...initial, expectedHead: status === "graded" || status === "needs_manual" ? rid : id,
    previousGradingVersion: 1, oldStatus: status ?? "needs_manual" } };
}
let host: HTMLDivElement, root: Root, clearIdentity: () => void;
let snapshot: typeof initial | ReturnType<typeof progress>["snapshot"];
let prepareBody: unknown, confirmBody: unknown, readBody: unknown, failure: number | null;
const fetchMock = vi.fn<typeof fetch>();
const begin = "新建一次AI评改版本", charge = "确认新建 AI 评改（这次另收费，旧未知费用不释放）", refresh = "重新读取本次评改状态（不调用 AI）";
beforeEach(() => {
  vi.resetAllMocks(); clearSessionExpiry();
  clearIdentity = publishVerifiedSessionIdentity({ id: crypto.randomUUID(), workspaceId: id });
  snapshot = initial; prepareBody = prepared(); confirmBody = progress("queued"); readBody = progress("graded"); failure = null;
  const identity = JSON.parse(getVerifiedSessionNamespace()!);
  fetchMock.mockImplementation(async (path, init) => {
    if (String(path) === "/api/auth/me") return Response.json({ user: { id: identity[0], workspaceId: identity[1] } });
    if (failure) return Response.json({ error: { code: failure === 401 ? "UNAUTHENTICATED" : "CONFLICT" } }, { status: failure });
    if (init?.method === "POST") {
      const body = String(path).endsWith("/confirm") ? confirmBody : prepareBody;
      if (String(path).endsWith("/confirm")) snapshot = (body as ReturnType<typeof progress>).snapshot;
      return Response.json(body, { status: String(path).endsWith("/confirm") ? 202 : 200 });
    }
    if (new URL(String(path), "http://localhost").searchParams.has("clientKey")) return Response.json(readBody);
    return Response.json({ snapshot });
  });
  vi.stubGlobal("fetch", fetchMock);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); clearIdentity(); vi.unstubAllGlobals(); });
const render = () => act(async () => root.render(<StrictMode><ExplicitRegradeHttpOwner observationId={id} /></StrictMode>));
async function remount() { await act(async () => root.unmount()); root = createRoot(host); await render(); }
async function click(text: string) {
  const button = [...host.querySelectorAll("button")].find(node => node.textContent === text);
  expect(button, text).toBeTruthy(); await act(async () => button!.click());
}
const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");

it("initializes by GET, sends real prepared/confirm, retains the operation over remount and reads its published result", async () => {
  await render(); expect(posts()).toHaveLength(0); expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith(`?observationId=${id}`))).toBe(true);
  await click(begin); expect(host.textContent).toContain("真实预算 ¥0.07"); expect(posts()).toHaveLength(1);
  expect(host.textContent).toContain("预估不是费用上限"); expect(host.textContent).toContain("备用模型可能改变费用");
  expect(host.textContent).toContain("两次都可能收费");
  await remount(); expect(host.textContent).toContain(charge); expect(posts()).toHaveLength(1);
  await click(charge); expect(host.textContent).toContain("后台处理");
  await remount(); expect(host.textContent).toContain("后台处理"); expect(posts()).toHaveLength(2);
  await click(refresh); expect(host.textContent).toContain("新 AI 评改已完成");
  const confirm = JSON.parse(String(posts()[1]![1]!.body));
  expect(confirm).toEqual({ requestId: rid, confirmationVersion: EXPLICIT_REGRADE_CONFIRMATION_VERSION, acceptPossibleDoubleCharge: true });
  expect(request.answerRevision).toBe(1); expect(request.workSource?.physicalPage).toBe(3);
});

it.each(["graded", "needs_manual", "unknown_cost", null] as const)("accepts the current operation %s including result head and null enqueue status", async status => {
  confirmBody = progress(status);
  await render(); await click(begin); await click(charge);
  const expected = status === "graded" ? "新 AI 评改已完成" : status === "needs_manual" ? "新评改暂不能给出确定结果"
    : status === "unknown_cost" ? "新评改的费用或发送结果也未确认" : "尚未确认进入队列";
  expect(host.textContent).toContain(expected); expect(host.textContent).not.toContain(begin);
  readBody = progress(status); await click(refresh); expect(host.textContent).toContain(expected); expect(posts()).toHaveLength(2);
});

it("keeps a published result's current snapshot head while unknown-cost status still points to the original answer", async () => {
  confirmBody = progress("needs_manual");
  await render(); await click(begin); await click(charge);
  await remount(); expect(host.textContent).toContain("新评改暂不能给出确定结果");
  readBody = { ...progress("unknown_cost"), snapshot: { ...progress("unknown_cost").snapshot, expectedHead: rid },
    progress: { ...progress("unknown_cost").progress, request: { ...progress("unknown_cost").progress.request, resultObservationId: rid } } };
  await click(refresh); expect(host.textContent).toContain("新评改的费用或发送结果也未确认");
  expect(host.textContent).not.toContain(begin); expect(posts()).toHaveLength(2);
});

it("omits null requestId during read-only lost-prepare recovery and never replays a lost confirm", async () => {
  await render();
  fetchMock.mockImplementationOnce(async () => { throw Error("offline auth read"); });
  await click(begin); expect(posts()).toHaveLength(0);
  readBody = prepared(); await click(refresh);
  const query = fetchMock.mock.calls.map(([url]) => new URL(String(url), "http://localhost")).find(url => url.searchParams.has("clientKey"));
  expect(query?.searchParams.has("requestId")).toBe(false); expect(host.textContent).toContain(charge);
  const normal = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url, init) => { if (String(url).endsWith("/confirm")) throw Error("lost confirm response"); return normal(url, init); });
  await click(charge); expect(host.textContent).toContain("操作结果尚未确认");
  await remount(); await click(refresh); expect(host.textContent).not.toContain(charge); expect(host.textContent).not.toContain(begin);
});

it.each([401, 403, 409])("handles HTTP %s without starting another charge", async status => {
  await render(); await click(begin); failure = status; await click(charge);
  expect(host.textContent).not.toContain(begin); expect(host.textContent).not.toContain(charge);
  expect(host.textContent).toContain(status === 409 ? "作答、隐私状态或评改版本已变化" : status === 401 ? "登录已失效" : "账户或权限已变化");
  expect(posts()).toHaveLength(2);
});

it("requires the real numeric estimate, not just server-looking copy", async () => {
  prepareBody = { ...prepared(), estimateCents: null };
  await render(); await click(begin); await click(charge); expect(posts()).toHaveLength(1); expect(host.textContent).toContain("暂不可用");
});

it("uses a live snapshot rather than a captured prop after a head/privacy/version refresh", async () => {
  await render(); await click(begin);
  snapshot = { ...initial, privacyEpoch: 1, previousGradingVersion: 1, expectedHead: rid };
  await remount(); expect(host.textContent).not.toContain(charge); expect(host.textContent).not.toContain(begin);
  expect(posts()).toHaveLength(1);
});

it("drops the tab session on verified owner switch and ignores a late old response", async () => {
  await render(); await click(begin);
  let resolve!: (response: Response) => void;
  const normal = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url, init) => String(url).endsWith("/confirm") ? new Promise<Response>(yes => { resolve = yes; }) : normal(url, init));
  await click(charge);
  clearIdentity(); clearIdentity = publishVerifiedSessionIdentity({ id: "different", workspaceId: id });
  await act(async () => resolve(Response.json(progress("queued"), { status: 202 })));
  await remount(); expect(host.textContent).not.toContain("后台处理"); expect(host.textContent).not.toContain(begin);
  expect(host.textContent).toContain("账户或权限已变化");
});

it("HTTP boundary validates payloads and never manufactures a price or serializes null", async () => {
  const http = createExplicitRegradeHttp(vi.fn(), async () => undefined, fetchMock);
  readBody = prepared(); await http.adapter.read({ observationId: id, clientKey: "recover", requestId: null });
  expect(String(fetchMock.mock.calls.at(-1)![0])).toBe(`/api/opening/observations/regrade?observationId=${id}&clientKey=recover`);
  readBody = { ...prepared(), request: { ...request, operationId: null } };
  await expect(http.adapter.read({ observationId: id, clientKey: "recover", requestId: null })).rejects.toThrow();
});
