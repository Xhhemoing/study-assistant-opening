// @vitest-environment jsdom
import { createElement } from "react";
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SENSEWEAVE_INITIAL_GATES } from "@aistudy/config/public";
import { publishVerifiedSessionIdentity } from "../../auth/session-identity";
import { prepareSenseWeave } from "./senseweave-host";
import { SenseWeaveAnswer } from "./senseweave-answer";
const mounts = vi.hoisted(() => ({ mount: vi.fn(), unmount: vi.fn() }));
vi.mock("@aistudy/senseweave/block", () => ({ mountBlock: mounts.mount }));
// Keep this a React ownership/fallback test, not a second Markdown/KaTeX renderer test.
vi.mock("./learning-prose", () => ({ LearningProse: ({ text, sourceOffset = 0 }: { text: string; sourceOffset?: number }) => createElement("p", { "data-source": sourceOffset }, text) }));
const text = `原始说明${"内容保持不变。".repeat(20)}\n\n| 名称 | 数量 (题) |\n|---|---|\n| A | 1 |\n| B | 2 |\n| C | 3 |\n| D | 4 |\n| E | 5 |`;
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.resetAllMocks(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  publishVerifiedSessionIdentity({ id: crypto.randomUUID(), workspaceId: "fixture" });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  mounts.mount.mockResolvedValue({ unmount: mounts.unmount });
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
it("explicit revert restores the exact source and unmounts only the selected block", async () => {
  const prepared = prepareSenseWeave({ id: "test", text }, undefined, SENSEWEAVE_INITIAL_GATES);
  await act(async () => { root.render(createElement(SenseWeaveAnswer, { text, prepared })); });
  expect(mounts.mount).toHaveBeenCalledTimes(1);
  const button = Array.from(container.querySelectorAll("button")).find(el => el.textContent === "改回文字")!;
  expect(button).toBeTruthy(); await act(async () => button.click());
  expect(container.textContent).toBe(text);
  expect(mounts.unmount).toHaveBeenCalledTimes(1);
  await act(async () => root.render(createElement(SenseWeaveAnswer, { text, prepared: { ...prepared } })));
  expect(container.textContent).toBe(text);
  expect(mounts.mount).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[data-source="'+text.indexOf('| 名称')+'"]')).not.toBeNull();
});
it("rejected lazy mounting falls back to the original fragment without throwing away adjacent prose", async () => {
  mounts.mount.mockRejectedValue(new Error("fixture module unavailable"));
  const prepared = prepareSenseWeave({ id: "failed", text }, undefined);
  await act(async () => { root.render(createElement(SenseWeaveAnswer, { text, prepared })); });
  expect(container.textContent).toBe(text);
  expect(container.querySelector('[data-senseweave-block]')).toBeNull();
});
it("a mount that settles after unmount is immediately cleaned up", async () => {
  let settle!: (value: { unmount: () => void }) => void;
  mounts.mount.mockImplementation(() => new Promise(resolve => { settle = resolve; }));
  const prepared = prepareSenseWeave({ id: "late", text }, undefined);
  await act(async () => { root.render(createElement(SenseWeaveAnswer, { text, prepared })); });
  await act(async () => root.render(null));
  await act(async () => settle({ unmount: mounts.unmount }));
  expect(mounts.unmount).toHaveBeenCalledTimes(1);
});
it("placement replace: the chart stands in for its sentence and 改回文字 restores the exact answer once", async () => {
  const sentence = "四次测验的成绩：第一次 60 分，第二次 70 分，第三次 80 分，第四次 90 分。";
  const answer = `请先通读题目，标出已知量、未知量和隐含条件，再决定使用哪个公式。这一题的思路是先把已知条件整理清楚，再逐步代入，每一步都检查单位和符号，避免把中间量弄混。${sentence}整体是稳步上升的。`;
  const prepared = prepareSenseWeave({ id: "replace", text: answer }, "成绩趋势");
  await act(async () => { root.render(createElement(SenseWeaveAnswer, { text: answer, prepared })); });
  expect(mounts.mount).toHaveBeenCalledTimes(1);
  expect(mounts.mount.mock.calls[0]![1].placement).toBe("replace");
  expect(container.textContent).not.toContain("第一次 60 分");
  const [before, after] = answer.split(sentence);
  expect(container.textContent).toBe(`${before}改回文字${after}`);
  const button = Array.from(container.querySelectorAll("button")).find(el => el.textContent === "改回文字")!;
  await act(async () => button.click());
  expect(container.textContent).toBe(answer);
  expect(container.textContent!.split(sentence)).toHaveLength(2);
});
