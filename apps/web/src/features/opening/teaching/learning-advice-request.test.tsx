// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LearningAdviceRequest } from "./learning-advice-request";
import type { LearningAdviceContext, LearningAdviceTransport } from "./learning-advice-request-model";

const context: LearningAdviceContext = { actorKey: "private-actor", courseId: "private-course", activityId: "private-activity",
  attemptId: "private-attempt", revision: 7, accessEpoch: 1 };
const ruleDecision = { activityKind: "diagnose", reasonCode: "no_evidence" };
const off = { advice: { ruleDecision, status: "disabled", experimentalAdvice: null }, experimentState: "off", messageCode: "off" };
const compared = { advice: { ruleDecision, status: "compared", experimentalAdvice: { kind: "supported_practice" } },
  experimentState: "ready", messageCode: "compared" };
function deferred() {
  let resolve!: (value: unknown) => void, reject!: (error: unknown) => void;
  const promise = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
let host: HTMLDivElement, root: Root;
let pending: ReturnType<typeof deferred>[];
let transport: ReturnType<typeof vi.fn<LearningAdviceTransport>>;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("no actual network"); }));
  vi.spyOn(Storage.prototype, "setItem"); vi.spyOn(Storage.prototype, "getItem");
  vi.spyOn(Storage.prototype, "removeItem"); vi.spyOn(Storage.prototype, "clear");
  vi.spyOn(history, "pushState"); vi.spyOn(history, "replaceState");
  pending = [];
  transport = vi.fn<LearningAdviceTransport>(() => { const row = deferred(); pending.push(row); return row.promise; });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  expect(fetch).not.toHaveBeenCalled();
  for (const method of ["setItem", "getItem", "removeItem", "clear"] as const) expect(Storage.prototype[method]).not.toHaveBeenCalled();
  expect(history.pushState).not.toHaveBeenCalled(); expect(history.replaceState).not.toHaveBeenCalled();
  host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
async function render(value: LearningAdviceContext | null = context, injected: LearningAdviceTransport = transport) {
  await act(async () => root.render(<LearningAdviceRequest context={value} transport={injected} />));
}
async function resolve(index: number, value: unknown) { await act(async () => pending[index]!.resolve(value)); }
async function reject(index: number, error: unknown) { await act(async () => pending[index]!.reject(error)); }
function checkbox() { return host.querySelector<HTMLInputElement>('input[type="checkbox"]')!; }
async function toggle() { await act(async () => checkbox().click()); }
function safeDom() {
  expect(host.innerHTML).not.toMatch(/private-|probability|dataAsOf|rawReason|no_evidence|insufficient_samples|priority_rule|0\.99|95%/);
  expect(host.querySelectorAll("a,form,select")).toHaveLength(0);
}

it("renders the real component rule-first, labeled/default off and with a single checkbox", async () => {
  await render();
  expect(checkbox().checked).toBe(false); expect(checkbox().labels?.[0]?.textContent).toContain("查看未校准实验建议（仅本次）");
  expect(host.querySelectorAll("input")).toHaveLength(1);
  expect(host.querySelector("section")?.firstElementChild?.getAttribute("aria-label")).toBe("当前规则建议");
  expect(transport).toHaveBeenCalledTimes(1); expect(transport.mock.calls[0]![0].body.optIn).toBe(false);
  expect(host.querySelector('[aria-label="未校准实验建议"]')).toBeNull();
  await resolve(0, off);
  expect(host.textContent).toContain("先做一次独立检查。");
  expect(host.textContent).toContain("不代表掌握程度，不改变晋级或考试安排，不自动选题");
  expect(host.textContent).toContain("样本门槛是实验约定，不是充分学习证据");
  expect(host.textContent).toContain("开启意愿不代表实验已获准"); safeDom();
});

it.each([off,
  { advice: null, experimentState: "off", messageCode: "off" },
  { advice: null, experimentState: "unavailable", messageCode: "unavailable" },
  { advice: { ruleDecision, status: "unavailable", experimentalAdvice: null }, experimentState: "unavailable", messageCode: "unavailable" },
])("a real click only requests intent; server off/unavailable/null never becomes compared: %j", async response => {
  await render(); await resolve(0, off); const ruleBefore = host.querySelector('[aria-label="当前规则建议"]')?.textContent;
  await toggle(); expect(transport.mock.calls[1]![0].body.optIn).toBe(true);
  expect(host.textContent).toContain("正在读取实验建议");
  expect(host.querySelector('[aria-label="当前规则建议"]')?.textContent).toBe(ruleBefore);
  await resolve(1, response);
  expect(checkbox().checked).toBe(true);
  expect(host.textContent).not.toContain("实验提示：");
  expect(host.textContent).not.toMatch(/已掌握|实验成功|稳固/);
  expect(host.querySelector('[role="alert"]')).toBeNull(); safeDom();
});

it.each(["supported_practice", "continue_rule"])("shows only the safe %s shadow copy; cancelling immediately removes it", async kind => {
  await render(); await resolve(0, off); await toggle();
  await resolve(1, { ...compared, advice: { ...compared.advice, experimentalAdvice: { kind } } });
  expect(host.textContent).toContain(kind === "supported_practice" ? "可考虑增加有支持的练习" : "保留当前规则建议");
  expect(host.textContent).toContain("先做一次独立检查。");
  expect(host.querySelector('[aria-label="未校准实验建议"]')?.getAttribute("role")).toBe("status");
  await toggle(); expect(checkbox().checked).toBe(false);
  expect(host.querySelector('[aria-label="未校准实验建议"]')).toBeNull();
  expect(transport.mock.calls[2]![0].body.optIn).toBe(false); safeDom();
});

it.each(["disabled", "incomplete_target", "invalid_cutoff", "priority_rule", "no_qualified_samples", "insufficient_samples", "additional_support", "retain_rule"])("maps %s to fixed safe fallback without claiming mastery", async reason => {
  await render(); await resolve(0, off); await toggle();
  await resolve(1, { advice: { ruleDecision, status: "fallback", experimentalAdvice: null, reason }, experimentState: "ready", messageCode: "fallback" });
  expect(host.textContent).toContain("规则建议"); expect(host.textContent).not.toContain("实验提示："); safeDom();
});

it("late promises and reverse order after off/on do not refill the old comparison", async () => {
  await render(); await resolve(0, off); await toggle(); const oldSignal = transport.mock.calls[1]![0].signal;
  await toggle(); expect(oldSignal.aborted).toBe(true); expect(host.textContent).not.toContain("实验提示：");
  await toggle();
  await resolve(3, { ...compared, advice: { ...compared.advice, experimentalAdvice: { kind: "continue_rule" } } });
  await resolve(1, compared); await reject(2, new Error("private-late-failure"));
  expect(host.textContent).toContain("保留当前规则建议"); expect(host.textContent).not.toContain("可考虑增加有支持的练习");
  expect(host.querySelector('[role="alert"]')).toBeNull(); safeDom();
});

it.each(["actorKey", "courseId", "activityId", "attemptId", "revision", "accessEpoch"] as const)("remounts on %s without painting the prior actor's rule/shadow", async key => {
  await render(); await resolve(0, off); await toggle(); await resolve(1, compared); await toggle(); await toggle();
  const oldSignal = transport.mock.calls[3]![0].signal;
  const next = { ...context, [key]: typeof context[key] === "number" ? 8 : "other-private" } as LearningAdviceContext;
  await render(next);
  expect(oldSignal.aborted).toBe(true); expect(checkbox().checked).toBe(false);
  expect(host.textContent).not.toContain("先做一次独立检查。"); expect(host.textContent).not.toContain("实验提示：");
  expect(transport.mock.calls[4]![0].body.optIn).toBe(false);
  await resolve(3, compared); expect(host.textContent).not.toContain("先做一次独立检查。");
  await resolve(4, off); expect(host.textContent).toContain("先做一次独立检查。"); safeDom();
});

it("null context covers logout/origin change/execution unavailable; old promises cannot resurrect results", async () => {
  await render(); await resolve(0, off); await toggle();
  await render(null); expect(checkbox().disabled).toBe(true); expect(checkbox().checked).toBe(false);
  expect(transport.mock.calls[1]![0].signal.aborted).toBe(true);
  await resolve(1, compared); expect(host.textContent).not.toContain("实验提示：");
  expect(host.textContent).not.toContain("先做一次独立检查。");
  await toggle(); expect(transport).toHaveBeenCalledTimes(2);
  await render(); expect(checkbox().checked).toBe(false); expect(transport.mock.calls[2]![0].body.optIn).toBe(false); safeDom();
});

it("blur/focus and page hide/show discard this visit's intent, rereading only false on return", async () => {
  await render(); await resolve(0, off); await toggle();
  await act(async () => window.dispatchEvent(new Event("blur")));
  expect(transport.mock.calls[1]![0].signal.aborted).toBe(true); expect(checkbox().checked).toBe(false);
  expect(host.textContent).not.toContain("先做一次独立检查。"); await resolve(1, compared);
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(transport.mock.calls[2]![0].body.optIn).toBe(false);
  await act(async () => window.dispatchEvent(new Event("focus"))); expect(transport).toHaveBeenCalledTimes(3);
  await resolve(2, off); await toggle(); await resolve(3, compared);
  await act(async () => window.dispatchEvent(new Event("pagehide")));
  expect(checkbox().checked).toBe(false); expect(host.textContent).not.toContain("实验提示：");
  await act(async () => window.dispatchEvent(new Event("pageshow")));
  expect(transport.mock.calls[4]![0].body.optIn).toBe(false); safeDom();
});

it("hidden/visible lifecycle resets, including an initially hidden mount", async () => {
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  await render(); expect(transport.mock.calls[0]![0].signal.aborted).toBe(true);
  await resolve(0, off); expect(host.textContent).not.toContain("先做一次独立检查。");
  visibility.mockReturnValue("visible");
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(transport.mock.calls[1]![0].body.optIn).toBe(false); await resolve(1, off); await toggle();
  visibility.mockReturnValue("hidden"); await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(transport.mock.calls[2]![0].signal.aborted).toBe(true); expect(checkbox().checked).toBe(false);
  safeDom();
});

it("same-value rerenders preserve the in-flight request; changing transport invalidates it", async () => {
  await render(); await render({ ...context }); expect(transport).toHaveBeenCalledTimes(1);
  await resolve(0, off); await toggle();
  const second = vi.fn<LearningAdviceTransport>(async () => off);
  await render(context, second);
  expect(transport.mock.calls[1]![0].signal.aborted).toBe(true);
  expect(checkbox().checked).toBe(false); expect(second.mock.calls[0]![0].body.optIn).toBe(false);
  await resolve(1, compared); expect(host.textContent).not.toContain("实验提示："); safeDom();
});

it.each([new Error("private-server-message probability=0.99"), new DOMException("private-timeout", "TimeoutError"),
  new DOMException("private-abort", "AbortError")])("shows safe failure, preserves current rule and retries only by click: %j", async error => {
  await render(); await resolve(0, off); await toggle(); await reject(1, error);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("建议读取失败");
  expect(host.textContent).toContain("先做一次独立检查。"); expect(host.textContent).not.toContain("实验提示：");
  expect(transport).toHaveBeenCalledTimes(2); safeDom();
  await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
  expect(transport).toHaveBeenCalledTimes(3); expect(transport.mock.calls[2]![0].body.optIn).toBe(true);
  await resolve(2, compared); expect(host.querySelector('[role="alert"]')).toBeNull(); safeDom();
});

it.each([
  { ...compared, probability: 0.99, dataAsOf: "private-time", rawReason: "private-reason" },
  { ...compared, advice: { ...compared.advice, experimentalAdvice: { kind: "continue_rule", probability: 0.99 } } },
  { ...compared, advice: { ...compared.advice, ruleDecision: { ...ruleDecision, reasonCode: "private-reason" } } },
  compared.advice,
])("does not put malformed/private responses or bare safe ports into DOM: %j", async value => {
  await render(); await resolve(0, off); await toggle(); await resolve(1, value);
  expect(host.querySelector('[role="alert"]')).not.toBeNull(); expect(host.textContent).not.toContain("实验提示："); safeDom();
});

it("never invents a rule after initial failure and does not accept an unrequested safe comparison", async () => {
  await render(); await resolve(0, compared);
  expect(host.textContent).toContain("暂时无法读取建议，原学习记录和步骤保留");
  expect(host.textContent).not.toContain("先做一次独立检查。"); expect(host.querySelector('[role="alert"]')).not.toBeNull();
  await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
  expect(transport.mock.calls[1]![0].body.optIn).toBe(false);
  await reject(1, new Error("private-error")); expect(host.textContent).not.toContain("先做一次独立检查。"); safeDom();
});

it("synchronous transport lifecycle callbacks suspend before retry and unmount without dispatching stale intent", async () => {
  await render(); await resolve(0, off);
  transport.mockImplementationOnce(() => {
    window.dispatchEvent(new Event("blur"));
    const row = deferred(); pending.push(row); return row.promise;
  });
  await toggle(); expect(checkbox().checked).toBe(false);
  expect(transport.mock.calls[1]![0].signal.aborted).toBe(true);
  await resolve(1, compared); expect(host.textContent).not.toContain("实验提示：");
  await act(async () => window.dispatchEvent(new Event("focus"))); await resolve(2, off);
  await toggle(); await reject(3, new Error("private-retry"));
  await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
  expect(transport).toHaveBeenCalledTimes(5);
  expect(transport.mock.calls[4]![0].body.optIn).toBe(true);
  const active = transport.mock.calls.length - 1;
  transport.mock.calls[active]![0].signal.addEventListener("abort", () => window.dispatchEvent(new Event("focus")), { once: true });
  await act(async () => root.render(null));
  expect(transport.mock.calls[active]![0].signal.aborted).toBe(true);
  expect(transport).toHaveBeenCalledTimes(active + 1);
  await resolve(active, compared); expect(host.textContent).toBe(""); safeDom();
});

it("unmount aborts, clears listeners, ignores late rejection, and reentry is default-off even in StrictMode", async () => {
  await act(async () => root.render(<StrictMode><LearningAdviceRequest context={context} transport={transport} /></StrictMode>));
  const current = pending.length - 1;
  await resolve(current, off); await toggle(); const active = pending.length - 1;
  await act(async () => root.render(null)); expect(transport.mock.calls[active]![0].signal.aborted).toBe(true);
  await reject(active, new Error("private-after-unmount"));
  await act(async () => { window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); });
  const count = transport.mock.calls.length; await render();
  expect(transport).toHaveBeenCalledTimes(count + 1); expect(checkbox().checked).toBe(false);
  expect(transport.mock.calls.at(-1)![0].body.optIn).toBe(false); safeDom();
});
