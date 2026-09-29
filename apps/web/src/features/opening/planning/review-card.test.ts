import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { createOpeningApi } from "../client/api";
import { ReviewCard } from "./review-card";
import { createReviewActions } from "./review-service";
import type { ReviewItem } from "./review-types";

const id = "11111111-1111-4111-8111-111111111111";
const assistant: ReviewItem = { ref: { origin: "assistant", kind: "task", id }, title: "练习", sourceNames: [], version: 0,
  proposal: { kind: "task", title: "练习", minutes: 20, dueText: null } };

it("identifies a source-free assistant suggestion as coming from saved conversation", () => {
  const html = renderToStaticMarkup(createElement(ReviewCard, { item: assistant, actions: createReviewActions(createOpeningApi()) }));
  expect(html).toContain("来自已保存的对话");
});

it("identifies a source-free retest as learning and skill evidence rather than saved conversation", () => {
  const item: ReviewItem = { ...assistant, ref: { origin: "retest", kind: "retest", id },
    proposal: { kind: "retest", id, courseId: id, skillLabel: "复习", prompt: "再试一次", sourceIds: [], dueAt: "2026-10-01T00:00:00Z", accepted: false } };
  const html = renderToStaticMarkup(createElement(ReviewCard, { item, actions: createReviewActions(createOpeningApi()) }));
  expect(html).toContain("来自学习记录与技能线索");
  expect(html).not.toContain("来自已保存的对话");
});
