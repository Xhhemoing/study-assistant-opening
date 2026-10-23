// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const recognition = vi.hoisted(() => vi.fn());
vi.mock("./photo-practice-client", () => ({ photoQuestionRecognition: recognition }));
import { PhotoRecognitionEditor } from "./photo-recognition-editor";
const id = "11111111-1111-4111-8111-111111111111";
const idle = { sourceId: id, sourceVersion: 0, jobId: null, status: "idle", proposal: null };
const proposal = { stem: "计算【待核对】+1", uncertainFragments: [{ fragment: "【待核对】", reason: "数字模糊" }] };
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  recognition.mockReset(); recognition.mockResolvedValue(idle);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const render = async (onUse = vi.fn()) => { await act(async () => root.render(createElement(PhotoRecognitionEditor, { sourceId: id, sourceVersion: 0, disabled: false, onUse }))); return onUse; };
it("reads without a model request, requires explicit recognition and explicit use before editing", async () => {
  const onUse = await render();
  expect(recognition).toHaveBeenCalledExactlyOnceWith({ sourceId: id, sourceVersion: 0 });
  recognition.mockResolvedValue({ ...idle, status: "ready", jobId: id, proposal });
  await act(async () => Array.from(host.querySelectorAll("button")).find(button => button.textContent === "识别题干")!.click());
  expect(recognition.mock.calls.some(call => call[1] === true)).toBe(true);
  expect(onUse).not.toHaveBeenCalled(); expect(host.textContent).toContain("数字模糊");
  await act(async () => Array.from(host.querySelectorAll("button")).find(button => button.textContent === "使用识别题干，继续编辑")!.click());
  expect(onUse).toHaveBeenCalledExactlyOnceWith(proposal);
});
it("recovers a completed candidate through GET without automatically replacing the learner's draft", async () => {
  recognition.mockResolvedValue({ ...idle, status: "ready", jobId: id, proposal });
  const onUse = await render();
  expect(onUse).not.toHaveBeenCalled(); expect(recognition.mock.calls.every(call => call.length === 1)).toBe(true);
  expect(host.querySelector('[aria-label="需要核对的片段"]')?.textContent).toContain("数字模糊");
});
it("polls a running job through reads, never an automatic second POST", async () => {
  vi.useFakeTimers(); recognition.mockResolvedValue({ ...idle, status: "running", jobId: id });
  await render();
  await act(async () => vi.advanceTimersByTimeAsync(4000));
  expect(recognition).toHaveBeenCalledTimes(3);
  expect(recognition.mock.calls.every(call => call.length === 1)).toBe(true);
});
it("keeps unknown outcomes on read-only recovery and offers the manual fallback", async () => {
  recognition.mockResolvedValue({ ...idle, status: "unknown", jobId: id });
  await render();
  expect(host.textContent).toContain("本次不会再次请求模型");
  expect(host.textContent).toContain("手动填写");
  expect(Array.from(host.querySelectorAll("button")).some(button => button.textContent === "识别题干")).toBe(false);
  await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
  expect(recognition.mock.calls.every(call => call.length === 1)).toBe(true);
});
