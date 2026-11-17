// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ObjectConversationContext } from "../assistant/conversation-object-context";
import type { CourseSummary } from "./course-model";
import { CourseSprintMode } from "./course-sprint-mode";

const course: CourseSummary = {
  id: "11111111-1111-4111-8111-111111111111", title: "高等数学", slug: "calculus", description: "",
  createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z",
};
const conversationId = "22222222-2222-4222-8222-222222222222";

function sprintNavigation(archivedAt: string | null) {
  const html = renderToStaticMarkup(createElement(ObjectConversationContext.Provider, { value: conversationId },
    createElement(CourseSprintMode, { course: { ...course, archivedAt } })));
  const document = new DOMParser().parseFromString(html, "text/html");
  const links = [...document.querySelectorAll('nav[aria-label="冲刺课程"] a')];
  return Object.fromEntries(links.map(link => [link.textContent, link.getAttribute("href")]));
}

it("links active sprint courses to their exam and full route while preserving the conversation", () => {
  const hrefs = sprintNavigation(null);
  const path = `/opening/courses/${course.id}`;
  expect(hrefs).toEqual({
    "返回 高等数学": `${path}?conversation=${conversationId}`,
    "查看今日计划": "#course-sprint-plan",
    "真题与考前练习": `${path}/exam?conversation=${conversationId}`,
    "全课路线": `${path}?tab=units&conversation=${conversationId}#course-learning-route`,
  });
});

it("leaves only the return link in an archived course's sprint navigation", () => {
  expect(sprintNavigation("2026-11-01T00:00:00Z")).toEqual({
    "返回 高等数学": `/opening/courses/${course.id}?conversation=${conversationId}`,
  });
});
