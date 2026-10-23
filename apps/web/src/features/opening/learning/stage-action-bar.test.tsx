import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { learningObservation } from "../../../../../../packages/domain/src/opening/learning-summary-fixtures";
import { canCompleteObservation, observationStage, StageActionBar } from "./stage-action-bar";

it("does not treat a self-reported correct answer or zero hints as a reliable grade", () => {
  expect(observationStage({ ...learningObservation, outcome: "correct", verdictSource: "self_report", assistance: "independent" })).toBe("evaluation-pending");
  expect(observationStage({ ...learningObservation, outcome: "unverified" })).toBe("evaluation-pending");
  expect(observationStage({ ...learningObservation, revisionKind: "replace", verdictSource: "self_report" })).toBe("corrected");
});

it("offers no repeat action while the service request is processing", () => {
  const html = renderToStaticMarkup(createElement(StageActionBar, { stage: "processing", message: "正在批改，你的答案已保存。", primary: { label: "重试" } }));
  expect(html).toContain('data-attempt-stage="processing"');
  expect(html).not.toContain("<button");
});

it("renders one caller-owned main action for a failure without claiming a next review date", () => {
  const html = renderToStaticMarkup(createElement(StageActionBar, { stage: "failed", message: "批改失败，原答案仍在。", primary: { label: "重试批改" } }));
  expect(html.match(/<button/g)).toHaveLength(1);
  expect(html).toContain('role="alert"');
  expect(html).not.toContain("复习");
});


it("uses a normal navigation link for the reliable result's explicit finish action", () => {
  const html = renderToStaticMarkup(createElement(StageActionBar, { stage: "reliable", primary: { label: "结束练习", href: "/opening/today" } }));
  expect(html).toContain('href="/opening/today"');
  expect(html).toContain("结束练习");
  expect(html).not.toContain("<button");
});

it("finishes only an effective assessed result or an explicit correction with a known judgment", () => {
  const corrected = { ...learningObservation, revisionKind: "replace" as const, verdictSource: "self_report" as const, outcome: "incorrect" as const };
  expect(canCompleteObservation(corrected)).toBe(true);
  expect(canCompleteObservation({ ...corrected, outcome: "unverified" })).toBe(false);
  expect(canCompleteObservation({ ...corrected, revisionKind: "retract" })).toBe(false);
  expect(canCompleteObservation({ ...corrected, effectiveHeadId: "another-head" })).toBe(false);
  expect(canCompleteObservation({ ...learningObservation, verdictSource: "self_report", outcome: "correct" })).toBe(false);
});
