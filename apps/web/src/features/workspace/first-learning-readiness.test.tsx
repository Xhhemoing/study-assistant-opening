// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("../opening/v3/motion/view-transition", () => ({ TransitionLink: "a" }));
import { FirstLearningReadiness } from "./first-learning-readiness";

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  window.sessionStorage.clear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it("does not turn an unknown worker backlog into an AI unavailable reminder", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ items: [
    { key: "worker_backlog", ok: false, severity: "hard", status: "unknown", detail: "无法读取 worker 积压", fixHint: "检查服务" },
  ] })));
  await act(async () => root.render(<FirstLearningReadiness draftKey="unknown-worker" />));
  expect(host.querySelector('[aria-label="AI 就绪提醒"]')).toBeNull();
});

it("still shows a confirmed worker backlog after skipping unknown items", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ items: [
    { key: "parser_ocr", ok: false, severity: "soft", status: "unknown", detail: "OCR 未知", fixHint: "" },
    { key: "worker_backlog", ok: false, severity: "hard", detail: "有积压：超时任务 2", fixHint: "检查服务" },
  ] })));
  await act(async () => root.render(<FirstLearningReadiness draftKey="confirmed-worker" />));
  expect(host.querySelector('[aria-label="AI 就绪提醒"]')?.textContent).toContain("有积压：超时任务 2");
});
