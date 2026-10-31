import { expect, it } from "vitest";
import { photoPracticeView } from "./photo-practice";
import { stepRenderers } from "../step-renderers";

it.each([false, true])("projects confirmed photo content without inventing a verdict or next action (saved=%s)", saved => {
  const view = photoPracticeView({ attemptId: "attempt", stem: "原题干", answer: "第一行\n第二行", saved, locked: saved });
  expect(view.step).toEqual({ kind: "practice", id: "attempt", title: saved ? "已保存的作答" : "完成自己的尝试", prompt: "原题干", estimateMinutes: null });
  expect(view.answer).toEqual({ answer: "第一行\n第二行" });
  expect(view.result).toBeNull(); expect(view.next).toBeNull();
  expect(view.help.canRequest).toBe(false); expect(stepRenderers.practice).toBeTypeOf("function");
});
