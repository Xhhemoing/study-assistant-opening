// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InlineAnswerInput } from "./inline-answer-input";
import { VectorDiagram } from "./blocks/vector-diagram";
import { FeedbackPractice } from "../learning/feedback-practice";
import { StudyIntentControls } from "./study-intent-controls";

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });
async function setInput(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function click(text: string) {
  const button = [...container.querySelectorAll("button")].find(node => node.textContent === text);
  expect(button).toBeTruthy(); await act(async () => button!.click());
}

it("submits a choice with its option identity and accepts fractional numeric answers", async () => {
  const onChange = vi.fn();
  await act(async () => root.render(createElement(InlineAnswerInput, { interaction: { kind: "choice", options: [{ id: "A", label: "1" }, { id: "B", label: "2" }] }, value: "", disabled: false, onChange })));
  await act(async () => container.querySelectorAll<HTMLInputElement>("input")[1]!.click());
  expect(onChange).toHaveBeenLastCalledWith("B. 2");
  await act(async () => root.render(createElement(InlineAnswerInput, { interaction: { kind: "numeric" }, value: "", disabled: false, onChange })));
  await setInput(container.querySelector("input")!, "-1/2");
  expect(onChange).toHaveBeenLastCalledWith("-1/2");
});

it("updates the vector sum for negative and zero coefficients", async () => {
  await act(async () => root.render(createElement(VectorDiagram, { vectors: { v: [1, 2], w: [3, -1] } })));
  const sliders = container.querySelectorAll<HTMLInputElement>('input[type="range"]');
  await setInput(sliders[0]!, "-2"); await setInput(sliders[1]!, "0");
  expect(container.querySelector("svg")?.getAttribute("aria-label")).toContain("当前组合为(-2,-4)");
  expect(container.querySelector('[aria-live="polite"]')?.textContent).toContain("= (-2, -4)");
});

it("teaches after a wrong retry without creating a learning observation", async () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  const question = { prompt: "三阶单位矩阵的秩？", options: [{ id: "A", label: "2" }, { id: "B", label: "3" }], answerId: "B", explanation: "三列线性无关。" };
  await act(async () => root.render(createElement(FeedbackPractice, { question })));
  expect(container.querySelector("button")?.disabled).toBe(true);
  await act(async () => container.querySelector<HTMLInputElement>("input")!.click()); await click("检查这一步");
  expect(container.textContent).toContain("看看这里的区别"); expect(container.textContent).toContain(question.explanation);
  await click("再试一次");
  await act(async () => container.querySelectorAll<HTMLInputElement>("input")[1]!.click()); await click("检查这一步");
  expect(container.textContent).toContain("这一步做对了！"); expect(fetch).not.toHaveBeenCalled();
});

it("records confusion from an example before a question has been issued", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const intent = { purpose: "confused", timeBudgetMinutes: 20, language: "zh", pace: "slow", continuous: true, selfReportedFatigue: "unknown" };
  const event = { id, sessionId: id, activityId: id, attemptId: null, version: 1, change: { kind: "signal", signal: "confused" }, intent, signals: ["confused"], action: "diagnose", createdAt: "2026-10-21T00:00:00Z" };
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => Response.json(init?.method === "POST"
    ? { event, currentEvent: event, currentIntent: intent, currentVersion: 1, move: { id: "self-example", presentation: { instructions: "先看一个小步骤" }, studentAction: "比较两个坐标" } } : { event: null }));
  const onApplied = vi.fn();
  await act(async () => root.render(createElement(StudyIntentControls, { attempt: { courseId: id, sessionId: id }, onApplied })));
  const button = [...container.querySelectorAll("button")].find(node => node.textContent === "我没懂")!;
  expect(button.closest("details")).toBeNull();
  expect(container.textContent).toContain("讲快点");
  expect(container.textContent).toContain("讲细点");
  expect(container.textContent).not.toContain("直接给关键步骤");
  await click("我没懂");
  const post = fetch.mock.calls.find(call => call[1]?.method === "POST")!;
  expect(JSON.parse(String(post[1]!.body))).toEqual({ sessionId: id, clientKey: expect.any(String), change: { kind: "signal", signal: "confused" } });
  expect(onApplied).toHaveBeenCalledWith(intent, "diagnose", undefined);
  expect(container.textContent).toContain("放慢一点");
});
