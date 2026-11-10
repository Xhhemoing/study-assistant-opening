// @vitest-environment jsdom
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EXPLICIT_REGRADE_CONFIRMATION_TEXT, EXPLICIT_REGRADE_CONFIRMATION_VERSION, type ExplicitRegradeRequest } from "@aistudy/contracts";
import { getVerifiedSessionNamespace, publishVerifiedSessionIdentity } from "../../auth/session-identity";
import { clearSessionExpiry } from "../../auth/session-expiry";
import { ExplicitRegradeHttpOwner } from "./explicit-regrade-owner";
import { TeachingContinueEntry } from "./teaching-workspace";
import type { LearningResume, TeachingActivity } from "@aistudy/contracts";
import type { OpeningApi } from "../client/api";


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


async function click(text: string) {
  const button = [...host.querySelectorAll("button")].find(node => node.textContent === text);
  expect(button, text).toBeTruthy(); await act(async () => button!.click());
}
const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");


it("X5: stable-owner regrade recovery stays GET-only while empty-ready refresh never enables an ungenerated question",async()=>{
 const activity:TeachingActivity={id,workspaceId:id,ownerUserId:id,courseId:null,status:"active",generateStatus:"ready",intentKind:"topic",intentSummary:"synthetic empty",sourceIds:[],pathVersion:1,contentVersion:0,clientKey:"empty-cross",createdAt:"2026-11-10T00:00:00.000Z",updatedAt:"2026-11-10T00:00:00.000Z"};
 const empty:LearningResume={activityId:id,status:"active",generateStatus:"ready",contentVersion:0,pathVersion:1,clientInit:null,thoughtTrain:{currentBlockId:null,skippedBlockIds:[],branchStack:[],commandLog:[]},drafts:[],interactionParams:{},actualAttempts:[],helpDelivered:[],openProblems:[],gates:{permission:"owned",materials:"available",unavailableSourceIds:[],job:"ready"},continuableActions:[],summary:{status:"skipped"}};
 const api={getTeachingResume:vi.fn().mockResolvedValue(empty),requestTeachingCompile:vi.fn(),getTeachingClientInit:vi.fn(),createAttempt:vi.fn()};
 const renderPair=()=>act(async()=>root.render(<StrictMode><ExplicitRegradeHttpOwner observationId={id}/>{createElement(TeachingContinueEntry,{activity,resume:empty,teachingCompileEnabled:false,api:api as unknown as OpeningApi})}</StrictMode>));
 await renderPair();expect(posts()).toHaveLength(0);await click(begin);await click(charge);expect(posts()).toHaveLength(2);
 await act(async()=>root.unmount());root=createRoot(host);await renderPair();
 expect(host.textContent).toContain("后台处理");expect(host.textContent).toContain("主讲内容未生成");expect(host.querySelector('[data-teaching-workspace]')).toBeNull();
 await act(async()=>host.querySelector<HTMLButtonElement>('[data-teaching-refresh-status]')!.click());
 readBody=progress("graded");await click(refresh);expect(host.textContent).toContain("新 AI 评改已完成");
 expect(host.textContent).toContain("主讲内容未生成");expect(host.querySelector('[data-teaching-request-compile]')).toBeNull();expect(host.querySelector('[data-teaching-workspace]')).toBeNull();
 await act(async()=>root.unmount());root=createRoot(host);await renderPair();
 expect(posts()).toHaveLength(2);expect(api.requestTeachingCompile).not.toHaveBeenCalled();expect(api.createAttempt).not.toHaveBeenCalled();expect(api.getTeachingClientInit).not.toHaveBeenCalled();
 const recovery=fetchMock.mock.calls.filter(([url,init])=>!(init?.method==="POST")&&String(url).includes("clientKey="));expect(recovery.length).toBeGreaterThan(0);
 expect(host.textContent).toContain("主讲内容未生成");
});
