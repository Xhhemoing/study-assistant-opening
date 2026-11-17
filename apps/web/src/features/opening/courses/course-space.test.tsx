// @vitest-environment jsdom
import { createElement, type AnchorHTMLAttributes } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { ObjectConversationContext } from "../assistant/conversation-object-context";
import { CourseSpaceHeader } from "./course-space";

vi.mock("../v3/motion/view-transition", () => ({
  TransitionLink: ({ children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) => createElement("a", props, children),
}));

const courseId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const conversation = "11111111-1111-4111-8111-111111111111";

function header(archived = false, conversationId: string | null = conversation) {
  const html = renderToStaticMarkup(createElement(ObjectConversationContext.Provider, { value: conversationId },
    createElement(CourseSpaceHeader, { courseId, title: "数学", archived })));
  return new DOMParser().parseFromString(html, "text/html");
}

it("shows sprint directly in the course header while keeping the original study action and conversation", () => {
  const document = header();
  const links = [...document.querySelectorAll("header a")];
  const sprint = links.find(link => link.textContent === "考前冲刺");
  expect(sprint?.getAttribute("href")).toBe(`/opening/sprint?courseId=${courseId}&conversation=${conversation}`);
  expect(sprint?.closest("details, [hidden]")).toBeNull();
  expect(links.find(link => link.textContent === "开始学习")?.getAttribute("href"))
    .toBe(`/opening/courses/${courseId}/study?conversation=${conversation}`);
});

it("keeps the canonical sprint route when no conversation is active", () => {
  const document = header(false, null);
  expect([...document.querySelectorAll("header a")].find(link => link.textContent === "考前冲刺")?.getAttribute("href"))
    .toBe(`/opening/sprint?courseId=${courseId}`);
});

it("does not offer sprint or study from an archived course header", () => {
  const document = header(true);
  const links = [...document.querySelectorAll("header a")];
  expect(links.some(link => link.textContent === "考前冲刺")).toBe(false);
  expect(links.some(link => link.getAttribute("href")?.includes("/study"))).toBe(false);
  expect(links.find(link => link.textContent === "全部课程")?.getAttribute("href")).toBe("/opening/courses");
  expect(document.body.textContent).toContain("已归档");
});
