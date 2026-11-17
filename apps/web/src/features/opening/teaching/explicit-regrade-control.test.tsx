// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EXPLICIT_REGRADE_CONFIRMATION_TEXT, EXPLICIT_REGRADE_CONFIRMATION_VERSION, type AiGradingStatus, type ExplicitRegradeRequest } from "@aistudy/contracts";
import { ExplicitRegradeControl } from "./explicit-regrade-control";
import { createExplicitRegradeSession, type ExplicitRegradeAdapter, type ExplicitRegradeOwner, type ExplicitRegradeRead, type ExplicitRegradeSnapshot } from "./explicit-regrade-client";

vi.mock("../design/ui", () => ({ ui: { primary: "primary", secondary: "secondary" } }));
const id = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";
const jobId = "33333333-3333-4333-8333-333333333333";
const snapshot: ExplicitRegradeSnapshot = { rootObservationId: id, expectedHead: id, answerRevision: 1,
  privacyEpoch: 4, previousGradingVersion: 0, epoch: 1, oldStatus: "unknown_cost" };
const request: ExplicitRegradeRequest = { requestId, rootObservationId: id, expectedHead: id, answerRevision: 1,
  privacyEpoch: 4, previousGradingVersion: 0, gradingVersion: 1, previousOperationId: "old-paid-operation",
  operationId: `ai-regrade:workspace:${requestId}`, confirmationVersion: EXPLICIT_REGRADE_CONFIRMATION_VERSION,
  confirmationText: EXPLICIT_REGRADE_CONFIRMATION_TEXT, workSource: { id: jobId, version: 2, physicalPage: 3 },
  state: "prepared", confirmedAt: null, jobId: null, resultObservationId: null };
function progress(status: AiGradingStatus["status"] | null): ExplicitRegradeRead {
  return { kind: "progress" as const, progress: { request: { ...request, state: "confirmed" as const,
    confirmedAt: "2026-11-10T12:00:00.000Z", jobId: status ? jobId : null, resultObservationId: status === "graded" ? jobId : null },
  status: status ? { rootObservationId: id, headObservationId: status === "graded" ? jobId : id, answerRevision: 1, jobId, status,
    retryable: false, autoGradeSkipped: null, workSource: request.workSource } : null } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const prepare = vi.fn<ExplicitRegradeAdapter["prepare"]>();
const confirm = vi.fn<ExplicitRegradeAdapter["confirm"]>();
const read = vi.fn<ExplicitRegradeAdapter["read"]>();
let host: HTMLDivElement, root: Root, owner: ExplicitRegradeOwner, current: ExplicitRegradeSnapshot;
beforeEach(() => {
  vi.resetAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  current = { ...snapshot };
  owner = { snapshot: current, session: createExplicitRegradeSession({ prepare, confirm, read }, value => JSON.stringify(value) === JSON.stringify(current)) };
  prepare.mockResolvedValue({ kind: "prepared", request, estimate: "约 ¥0.03–0.08" });
  confirm.mockResolvedValue(progress("queued")); read.mockResolvedValue(progress("graded"));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const render = (disabled = false) => act(async () => root.render(<StrictMode><ExplicitRegradeControl owner={owner} disabled={disabled} /></StrictMode>));
function button(label: string) {
  const result = [...host.querySelectorAll("button")].find(node => node.textContent === label);
  expect(result, label).toBeTruthy(); return result!;
}
const begin = "新建一次AI评改版本";
const charge = "确认新建 AI 评改（这次另收费，旧未知费用不释放）";
const refresh = "重新读取本次评改状态（不调用 AI）";
const click = (label: string) => act(async () => button(label).click());

it("does nothing on mount/replay, prepares exact stable identity and requires a separate double-charge confirmation", async () => {
  const original = structuredClone(request);
  await render(); await render();
  expect(prepare).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
  await click(begin);
  expect(prepare).toHaveBeenCalledExactlyOnceWith({ observationId: id, expectedHead: id, expectedGradingVersion: 0,
    clientKey: `explicit-regrade:${id}:${id}:1:4:0` });
  expect(confirm).not.toHaveBeenCalled();
  expect(host.textContent).toContain(EXPLICIT_REGRADE_CONFIRMATION_TEXT);
  expect(host.textContent).toContain("约 ¥0.03–0.08");
  expect(host.textContent).toContain("两次都可能收费");
  expect(host.textContent).toContain("新 AI 评改版本：1");
  await click(charge);
  expect(confirm).toHaveBeenCalledExactlyOnceWith({ requestId, confirmationVersion: EXPLICIT_REGRADE_CONFIRMATION_VERSION, acceptPossibleDoubleCharge: true });
  expect(host.textContent).toContain("新评改正在后台处理");
  await click(refresh);
  expect(read).toHaveBeenCalledExactlyOnceWith({ observationId: id, requestId, clientKey: `explicit-regrade:${id}:${id}:1:4:0` });
  expect(host.textContent).toContain("新 AI 评改已完成");
  expect(request).toEqual(original); // No answer revision, photo or operation mutation.
  expect(confirm).toHaveBeenCalledOnce();
});

it("synchronously locks duplicate prepare and confirm clicks and survives remount with the same tab session", async () => {
  const preparing = deferred<Awaited<ReturnType<ExplicitRegradeAdapter["prepare"]>>>();
  prepare.mockReturnValue(preparing.promise);
  await render();
  const first = button(begin);
  await act(async () => { first.click(); first.click(); });
  expect(prepare).toHaveBeenCalledOnce(); expect(host.textContent).toContain("正在准备新评改信息");
  await act(async () => preparing.resolve({ kind: "prepared", request, estimate: "约 ¥0.05" }));
  const confirming = deferred<Awaited<ReturnType<ExplicitRegradeAdapter["confirm"]>>>(); confirm.mockReturnValue(confirming.promise);
  const second = button(charge);
  await act(async () => { second.click(); second.click(); });
  expect(confirm).toHaveBeenCalledOnce(); expect(host.textContent).toContain("正在确认本次新评改");
  await act(async () => root.unmount()); root = createRoot(host); await render();
  expect(host.textContent).toContain("正在确认本次新评改");
  expect(host.textContent).not.toContain(begin);
  await act(async () => confirming.resolve(progress("queued")));
  expect(host.textContent).toContain("后台处理"); expect(confirm).toHaveBeenCalledOnce();
});

it.each(["queued", "grading", "graded", "unknown_cost", "needs_manual", null] as const)("shows new request state %s without another paid call", async status => {
  confirm.mockResolvedValue(progress(status));
  await render(); await click(begin); await click(charge); await render();
  const expected = status === "graded" ? "新 AI 评改已完成" : status === "unknown_cost" ? "新评改的费用或发送结果也未确认"
    : status === "needs_manual" ? "新评改暂不能给出确定结果" : status === null ? "尚未确认进入队列" : "新评改正在后台处理";
  expect(host.textContent).toContain(expected);
  expect(host.textContent).not.toContain(begin); expect(host.textContent).not.toContain(charge);
  expect(confirm).toHaveBeenCalledOnce(); expect(prepare).toHaveBeenCalledOnce();
});

it.each(["prepare", "confirm"])("keeps an unknown %s outcome read-only and never resends on replay or failure", async stage => {
  if (stage === "prepare") prepare.mockRejectedValue(new Error("connection lost"));
  else confirm.mockRejectedValue(new Error("connection lost"));
  await render(); await click(begin); if (stage === "confirm") await click(charge);
  expect(host.textContent).toContain("操作结果尚未确认");
  await render();
  read.mockRejectedValueOnce(new Error("read offline"));
  await click(refresh); expect(host.textContent).toContain("状态读取失败");
  read.mockResolvedValue({ kind: "prepared", request, estimate: "约 ¥0.05" });
  await click(refresh);
  // A lost prepare can recover the unconfirmed request. A lost confirm never gets a resend button.
  expect(host.textContent?.includes(charge)).toBe(stage === "prepare");
  expect(prepare).toHaveBeenCalledOnce(); expect(confirm).toHaveBeenCalledTimes(stage === "confirm" ? 1 : 0);
  expect(read).toHaveBeenCalledTimes(2);
});

it.each([null, "", "   "])("does not enable confirmation without a policy-backed price estimate: %s", async estimate => {
  prepare.mockResolvedValue({ kind: "prepared", request, estimate });
  await render(); await click(begin);
  expect(button(charge).disabled).toBe(true); await click(charge); expect(confirm).not.toHaveBeenCalled();
  expect(host.textContent).toContain("暂不可用");
});

it.each(["prepare", "confirm", "read"])("maps owner %s conflicts to refetch, never another paid action", async stage => {
  if (stage === "prepare") prepare.mockResolvedValue({ kind: "conflict" });
  if (stage === "confirm") confirm.mockResolvedValue({ kind: "conflict" });
  if (stage === "read") read.mockResolvedValue({ kind: "conflict" });
  await render(); await click(begin);
  if (stage !== "prepare") await click(charge);
  if (stage === "read") await click(refresh);
  expect(host.textContent).toContain("作答、隐私状态或评改版本已变化");
  expect(host.textContent).not.toContain(begin); expect(host.textContent).not.toContain(charge);
});

it.each(["expectedHead", "privacyEpoch", "previousGradingVersion", "answerRevision", "epoch"] as const)("ignores late prepare and stale confirm when owner %s changes", async field => {
  const pending = deferred<Awaited<ReturnType<ExplicitRegradeAdapter["prepare"]>>>(); prepare.mockReturnValue(pending.promise);
  await render(); await click(begin);
  const oldSnapshot = owner.snapshot;
  current = { ...current, [field]: field === "expectedHead" ? jobId : Number(current[field]) + 1 };
  owner = { ...owner, snapshot: current }; await render();
  await act(async () => pending.resolve({ kind: "prepared", request, estimate: "约 ¥0.05" }));
  await act(async () => owner.session.confirm(oldSnapshot));
  expect(confirm).not.toHaveBeenCalled(); expect(host.textContent).not.toContain(charge);
});

it("requires a read, not a new prepare, after same-identity owner epoch refresh", async () => {
  await render(); await click(begin);
  current = { ...current, epoch: current.epoch + 1 }; owner = { ...owner, snapshot: current }; await render();
  expect(host.textContent).toContain("作答、隐私状态或评改版本已变化");
  expect(host.textContent).not.toContain(charge); expect(host.textContent).not.toContain(begin);
  await click(refresh);
  expect(host.textContent).toContain("新 AI 评改已完成"); expect(prepare).toHaveBeenCalledOnce(); expect(confirm).not.toHaveBeenCalled();
});

it.each([{ ...request, answerRevision: 2 }, { ...request, gradingVersion: 4 }, { ...request, privacyEpoch: 5 },
  { ...request, operationId: request.previousOperationId }])("rejects a mismatched server snapshot without confirming", async mismatched => {
  prepare.mockResolvedValue({ kind: "prepared", request: mismatched, estimate: "约 ¥0.05" });
  await render(); await click(begin);
  expect(host.textContent).toContain("作答、隐私状态或评改版本已变化"); expect(confirm).not.toHaveBeenCalled();
});

it("locks reads and refuses a response that swaps the captured request or photo identity", async () => {
  await render(); await click(begin); await click(charge);
  const pending = deferred<Awaited<ReturnType<ExplicitRegradeAdapter["read"]>>>(); read.mockReturnValue(pending.promise);
  const refreshButton = button(refresh);
  await act(async () => { refreshButton.click(); refreshButton.click(); }); expect(read).toHaveBeenCalledOnce();
  const swapped = progress("graded"); swapped.progress.request.workSource = { ...request.workSource!, physicalPage: 4 };
  await act(async () => pending.resolve(swapped));
  expect(host.textContent).toContain("作答、隐私状态或评改版本已变化"); expect(confirm).toHaveBeenCalledOnce();
});

it("keeps a late confirmation out of the current head and never sends again after recovery", async () => {
  const pending = deferred<Awaited<ReturnType<ExplicitRegradeAdapter["confirm"]>>>(); confirm.mockReturnValue(pending.promise);
  await render(); await click(begin); await click(charge);
  current = { ...current, epoch: 2 }; owner = { ...owner, snapshot: current }; await render();
  await act(async () => pending.resolve(progress("queued")));
  expect(host.textContent).toContain("作答、隐私状态或评改版本已变化");
  read.mockResolvedValue(progress("unknown_cost")); await click(refresh);
  expect(host.textContent).toContain("新评改的费用或发送结果也未确认");
  await render(); expect(confirm).toHaveBeenCalledOnce(); expect(prepare).toHaveBeenCalledOnce();
});

it.each(["root", "head", "revision", "job", "request", "operation"])("rejects mismatched recovered %s identity", async field => {
  await render(); await click(begin); await click(charge);
  const result = progress("queued");
  if (field === "root") result.progress.status!.rootObservationId = requestId;
  if (field === "head") result.progress.status!.headObservationId = requestId;
  if (field === "revision") result.progress.status!.answerRevision = 2;
  if (field === "job") result.progress.status!.jobId = requestId;
  if (field === "request") result.progress.request.requestId = jobId;
  if (field === "operation") result.progress.request.operationId = "swapped-paid-operation";
  read.mockResolvedValue(result); await click(refresh);
  expect(host.textContent).toContain("作答、隐私状态或评改版本已变化"); expect(confirm).toHaveBeenCalledOnce();
});

it("does not treat a prepared consent or a queued label without a job as paid execution", async () => {
  const unconfirmed = progress(null); unconfirmed.progress.request.state = "prepared";
  confirm.mockResolvedValue(unconfirmed);
  await render(); await click(begin); await click(charge);
  expect(host.textContent).toContain("操作结果尚未确认");
  const noJob = progress("queued"); noJob.progress.request.jobId = null; noJob.progress.status!.jobId = null;
  read.mockResolvedValue(noJob); await click(refresh);
  expect(host.textContent).toContain("尚未确认进入队列"); expect(confirm).toHaveBeenCalledOnce();
});

it("does not offer the action for known old costs, or send when parent disabled", async () => {
  await render(true); await click(begin); expect(prepare).not.toHaveBeenCalled();
  current = { ...current, oldStatus: "graded" }; owner = { ...owner, snapshot: current }; await render();
  expect(host.querySelector("button")).toBeNull(); expect(prepare).not.toHaveBeenCalled();
});
