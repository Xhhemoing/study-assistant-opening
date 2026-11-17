// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SprintQuickStart } from "./sprint-quick-start";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("../v3/motion/view-transition", () => ({ useTransitionRouter: () => ({ push }) }));

const endpoint = "/api/opening/exam-sprint/quick-start";
const courseA = "11111111-1111-4111-8111-111111111111";
const courseB = "22222222-2222-4222-8222-222222222222";
let host: HTMLDivElement, root: Root;
const postMock = vi.fn();

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  push.mockReset();
  postMock.mockReset();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    expect(url).toBe(endpoint);
    if (init?.method === "POST") return postMock(init);
    return Response.json({ available: true });
  }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const button = () => host.querySelector("button")!;

it("recovers transient ref guard and status if navigation throws or POST fails", async () => {
  const hrefA = `/opening/courses/${courseA}?mode=sprint`;
  postMock.mockResolvedValueOnce(Response.json({ error: { message: "暂不可用" } }, { status: 409 }));
  postMock.mockResolvedValueOnce(Response.json({ courseId: courseA, href: hrefA }));
  postMock.mockResolvedValueOnce(Response.json({ courseId: courseA, href: hrefA }));

  await act(async () => root.render(createElement(SprintQuickStart, { courseId: courseA })));
  await act(async () => button().click());
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("暂不可用");
  expect(button().disabled).toBe(false);
  expect(button().textContent).toBe("重试开启");

  push.mockImplementationOnce(() => { throw new Error("router failed"); });
  await act(async () => button().click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("未能确认");
  expect(button().disabled).toBe(false);

  await act(async () => button().click());
  expect(push).toHaveBeenLastCalledWith(hrefA);
});

it("aborts pending polling and clears transient error and status when courseId changes", async () => {
  vi.useFakeTimers();
  const hrefB = `/opening/courses/${courseB}?mode=sprint`;
  postMock
    .mockResolvedValueOnce(Response.json({ pending: true }))
    .mockResolvedValueOnce(Response.json({ courseId: courseB, href: hrefB }));

  await act(async () => root.render(createElement(SprintQuickStart, { courseId: courseA })));
  await act(async () => button().click());
  expect(button().disabled).toBe(true);
  expect(button().textContent).toBe("正在准备…");

  await act(async () => root.render(createElement(SprintQuickStart, { courseId: courseB })));
  expect(button().disabled).toBe(false);
  expect(button().textContent).toBe("一键开启");
  expect(host.querySelector('[role="alert"]')).toBeNull();

  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(postMock).toHaveBeenCalledTimes(1);

  await act(async () => button().click());
  expect(push).toHaveBeenCalledWith(hrefB);
});
