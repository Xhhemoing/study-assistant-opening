// @vitest-environment jsdom
import { act, type AnchorHTMLAttributes } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SprintCourseChooser } from "./sprint-course-chooser";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("../v3/motion/view-transition", () => ({
  TransitionLink: (props: AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} />,
  useTransitionRouter: () => ({ push }),
}));

const endpoint = "/api/opening/exam-sprint/quick-start";
const courseId = "55555555-5555-4555-8555-555555555555";
const href = "/opening/courses/" + courseId + "?mode=sprint";
const post = vi.fn();
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  post.mockReset();
  push.mockReset();
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

async function showChooser(availability: Response | Error, courses: { id: string; title: string }[] = []) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (url === "/api/courses") return Response.json({ courses });
    if (url !== endpoint) throw new Error("Unexpected fetch " + url);
    if (options?.method === "POST") return post(options);
    if (availability instanceof Error) throw availability;
    return availability;
  }));
  await act(async () => root.render(<SprintCourseChooser />));
}

function button() {
  return [...host.querySelectorAll("button")].find(node => /开启|正在准备|继续检查|正在进入/.test(node.textContent ?? ""));
}

it("offers a one-click start ahead of the empty course list", async () => {
  await showChooser(Response.json({ available: true }));
  expect(button()?.textContent).toBe("一键开启");
  expect(host.textContent).toContain("3101");
  expect(host.textContent).toContain("还没有进行中的课程");
  expect(host.textContent!.indexOf("一键开启")).toBeLessThan(host.textContent!.indexOf("还没有进行中的课程"));
});

it.each([false, 401, 404, 503, "offline"] as const)("keeps manual course selection when quick start is unavailable (%s)", async (availability) => {
  const response = availability === "offline" ? new Error("Offline") : typeof availability === "number" ?
    Response.json({ available: true }, { status: availability }) : Response.json({ available: availability });
  await showChooser(response, [{ id: courseId, title: "线性代数" }]);
  expect(button()).toBeUndefined();
  expect(host.textContent).toContain("线性代数");
});

it("starts once while pending and opens the returned course after success", async () => {
  let finish!: (response: Response) => void;
  post.mockReturnValue(new Promise<Response>(resolve => { finish = resolve; }));
  await showChooser(Response.json({ available: true }));
  await act(async () => {
    button()!.click();
    button()!.click();
  });
  expect(post).toHaveBeenCalledTimes(1);
  expect(post).toHaveBeenCalledWith(expect.objectContaining({
    method: "POST", body: "{}", headers: { "content-type": "application/json" },
  }));
  expect(button()?.disabled).toBe(true);
  expect(push).not.toHaveBeenCalled();
  await act(async () => finish(Response.json({ courseId, href })));
  expect(push).toHaveBeenCalledWith(href);
});

it("offers an explicit retry after an unconfirmed request and never follows an external URL", async () => {
  post.mockRejectedValueOnce(new Error("Offline"));
  post.mockResolvedValueOnce(Response.json({ courseId, href: "https://example.com" + href }));
  post.mockResolvedValueOnce(Response.json({ courseId, href }));
  await showChooser(Response.json({ available: true }));
  await act(async () => button()!.click());
  expect(host.querySelector("[role=alert]")?.textContent).toContain("重试");
  expect(post).toHaveBeenCalledTimes(1);
  await act(async () => button()!.click());
  expect(push).not.toHaveBeenCalled();
  await act(async () => button()!.click());
  expect(push).toHaveBeenCalledWith(href);
});

it("continues preparing after a confirmed pending response", async () => {
  vi.useFakeTimers();
  post.mockResolvedValueOnce(Response.json({ pending: true }));
  post.mockResolvedValueOnce(Response.json({ courseId, href }));
  await showChooser(Response.json({ available: true }));
  await act(async () => button()!.click());
  expect(button()?.disabled).toBe(true);
  expect(push).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(post).toHaveBeenCalledTimes(2);
  expect(push).toHaveBeenCalledWith(href);
});

it("stops polling after leaving the chooser", async () => {
  vi.useFakeTimers();
  post.mockResolvedValueOnce(Response.json({ pending: true }));
  await showChooser(Response.json({ available: true }));
  await act(async () => button()!.click());
  await act(async () => root.render(null));
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(post).toHaveBeenCalledTimes(1);
  expect(push).not.toHaveBeenCalled();
});

it("shows the server's actionable error and leaves the learner in the chooser", async () => {
  const message = "冲刺题包已关联另一门课程，请打开原课程。";
  post.mockResolvedValueOnce(Response.json({ error: { message } }, { status: 409 }));
  await showChooser(Response.json({ available: true }));
  await act(async () => button()!.click());
  expect(host.querySelector("[role=alert]")?.textContent).toBe(message);
  expect(button()?.disabled).toBe(false);
  expect(push).not.toHaveBeenCalled();
});

it("lets the learner continue checking after the preparation wait ends", async () => {
  vi.useFakeTimers();
  post.mockImplementation(async () => Response.json({ pending: true }));
  await showChooser(Response.json({ available: true }));
  await act(async () => button()!.click());
  await act(async () => vi.advanceTimersByTimeAsync(120_000));
  expect(button()?.textContent).toBe("继续检查");
  const previousCalls = post.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(post).toHaveBeenCalledTimes(previousCalls);
  post.mockResolvedValueOnce(Response.json({ courseId, href }));
  await act(async () => button()!.click());
  expect(push).toHaveBeenCalledWith(href);
});
