// @vitest-environment jsdom
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DemoLesson } from "./demo-lesson";
import DemoLearningPage from "../../../app/demo/learning/page";

const router = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, notFound: () => { throw new Error("NOT_FOUND"); } }));
vi.mock("@aistudy/config", () => ({ loadFeatureSwitches: () => ({ explorePreview: true }) }));

let host: HTMLDivElement;
let root: Root;
let network: ReturnType<typeof vi.fn>;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  network = vi.fn(async () => { throw new Error("Demo must not request any transport"); });
  vi.stubGlobal("fetch", network);
  vi.spyOn(XMLHttpRequest.prototype, "open").mockImplementation(() => { throw new Error("XHR is forbidden in demo"); });
  router.replace.mockClear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

function button(label: string) {
  const result = Array.from(host.querySelectorAll("button")).find(item => item.textContent === label);
  if (!result) throw new Error(`Missing button ${label}`);
  return result;
}
async function click(label: string) { await act(async () => button(label).click()); }
async function edit(value: string) {
  const input = host.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("completes preview, fixed follow-up, hint, answer and revision with every transport forbidden", async () => {
  await act(async () => root.render(<DemoLesson />));
  expect(host.textContent).toContain("静态示例");
  expect(button("查看示例反馈").disabled).toBe(true);
  await edit("可以，因为箭头能伸长。");
  const input = host.querySelector("textarea")!;
  await click("张成空间（Span）");
  expect(host.querySelector('[aria-label="概念预览"]')?.textContent).toContain("预先编写");
  await click("继续问（固定示例）");
  expect(host.textContent).toContain("纵坐标始终为 0");
  await click("返回示例主线");
  expect(document.activeElement).toBe(button("张成空间（Span）"));
  expect(input.value).toBe("可以，因为箭头能伸长。");
  await click("看固定提示");
  expect(host.querySelector("#demo-hint")?.textContent).toContain("固定提示");
  await click("查看示例反馈");
  expect(host.querySelector('[role="status"]')?.textContent).toContain("固定内容，不判断你的答案");
  await click("自己改答");
  expect(document.activeElement).toBe(input);
  expect(input.value).toBe("可以，因为箭头能伸长。");
  await edit("不能，任意倍数的纵坐标仍是 0。");
  await click("查看示例反馈");
  expect(Array.from(host.querySelectorAll("ol li"), item => item.textContent)).toEqual(["可以，因为箭头能伸长。", "不能，任意倍数的纵坐标仍是 0。"]);
  expect(network).not.toHaveBeenCalled();
  expect(XMLHttpRequest.prototype.open).not.toHaveBeenCalled();
  expect(host.querySelector('a[href="/opening/today"]')).not.toBeNull();
});

it("supports Escape return, reset and a fresh mount without persisting demo answers", async () => {
  await act(async () => root.render(<DemoLesson />));
  await edit("旧草稿"); await click("查看示例反馈"); await click("看固定提示");
  await click("张成空间（Span）");
  await act(async () => host.querySelector("main")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(host.querySelector('[aria-label="概念预览"]')).toBeNull();
  expect(document.activeElement).toBe(button("张成空间（Span）"));
  await click("重置示例");
  expect(host.querySelector("textarea")?.value).toBe("");
  expect(host.querySelector("ol")).toBeNull();
  expect(host.querySelector("#demo-hint")).toBeNull();
  expect(host.querySelector('[role="status"]')).toBeNull();
  await edit("离开即清空");
  await act(async () => root.render(null));
  await act(async () => root.render(<DemoLesson />));
  expect(host.querySelector("textarea")?.value).toBe("");
  expect(network).not.toHaveBeenCalled();
});

it("uses the existing login gate and only reads auth identity before running a no-model demo", async () => {
  network.mockImplementation(async (url: string, options?: RequestInit) => {
    if (url === "/api/auth/me" && (!options?.method || options.method === "GET")) {
      return Response.json({ user: { id: "demo-student", workspaceId: "demo-workspace" } });
    }
    throw new Error(`Business and model transport forbidden: ${url}`);
  });
  await act(async () => root.render(<DemoLearningPage />));
  expect(host.querySelector("h1")?.textContent).toBe("先体验一小段学习");
  await click("张成空间（Span）"); await click("继续问（固定示例）"); await click("返回示例主线");
  await edit("不能。"); await click("查看示例反馈"); await click("自己改答");
  await edit("纵坐标始终不变。"); await click("查看示例反馈"); await click("重置示例");
  expect(network).toHaveBeenCalledTimes(1);
  expect(network).toHaveBeenCalledWith("/api/auth/me", { cache: "no-store" });
  expect(router.replace).not.toHaveBeenCalled();
});

it("does not expose the lesson through the login gate to an unauthenticated visitor", async () => {
  network.mockResolvedValue(new Response(null, { status: 401 }));
  await act(async () => root.render(<DemoLearningPage />));
  expect(host.querySelector("textarea")).toBeNull();
  expect(router.replace).toHaveBeenCalledOnce();
});
