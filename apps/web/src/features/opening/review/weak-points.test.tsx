// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WeakPoint, WeakPointsSummary } from "./weak-points-model";

const read = vi.hoisted(() => vi.fn());
vi.mock("./weak-points-client", () => ({ readWeakPoints: read }));
import { WeakPoints } from "./weak-points";

const courseId = "11111111-1111-4111-8111-111111111111";
const point: WeakPoint = {
  key: JSON.stringify([courseId, "span"]), courseId, courseTitle: "线代", requirementKey: "span", skillLabel: "求系数",
  state: "recent_independent", identityKnown: true, incorrect: 4, assisted: 1, independentCorrect: 1, total: 6,
  lastAttemptAt: "2026-10-23T00:00:00.000Z", lastStruggleAt: "2026-10-22T00:00:00.000Z",
};
const result = (points: WeakPoint[] = [point], incomplete = false): WeakPointsSummary => ({ points, evaluatedAt: "2026-10-23T00:00:00.000Z", incomplete });
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  read.mockReset(); read.mockResolvedValue(result());
  localStorage.clear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const render = () => act(async () => root.render(<WeakPoints />));

it("shows recent improvement without erasing old mistakes or declaring mastery", async () => {
  await render();
  expect(host.textContent).toContain("最近独立完成");
  expect(host.textContent).toContain("历史答错 4 次");
  expect(host.textContent).toContain("之后再检查能否记住和迁移");
  expect(host.textContent).not.toContain("已掌握");
  const practice = host.querySelector<HTMLAnchorElement>("a");
  expect(practice?.textContent).toBe("围绕此技能练习");
  expect(new URL(practice!.href).searchParams.get("requirementKey")).toBe("span");
  expect(read).toHaveBeenCalledTimes(1);
});

it("opens the real retest queue for a due item instead of the ordinary practice form", async () => {
  read.mockResolvedValue(result([{ ...point, state: "due_retest" }]));
  await render();
  const link = host.querySelector<HTMLAnchorElement>("a")!;
  expect(link.textContent).toBe("查看到期复测");
  const target = new URL(link.href);
  expect(target.pathname).toBe("/opening/review");
  expect(target.searchParams.get("tab")).toBe("retests");
  expect(target.searchParams.get("requirementKey")).toBe("span");
  expect(target.searchParams.has("mode")).toBe(false);
  expect(host.textContent).not.toContain("围绕此技能练习");
});

it("keeps incomplete warnings visible even when no points have been returned", async () => {
  read.mockResolvedValue(result([], true));
  await render();
  expect(host.textContent).toContain("列表可能不完整");
  expect(host.textContent).toContain("还没有易错点");
  const refresh = [...host.querySelectorAll("button")].find(button => button.textContent === "重新读取");
  await act(async () => refresh?.click());
  expect(read).toHaveBeenCalledTimes(2);
});

it("keeps self-selected causes local and restores them when the view mounts again", async () => {
  await render();
  const cause = [...host.querySelectorAll("button")].find(button => button.textContent === "计算失误")!;
  await act(async () => cause.click());
  expect(cause.getAttribute("aria-pressed")).toBe("true");
  expect(JSON.parse(localStorage.getItem("aistudy:weak-point-causes")!)).toEqual({ [point.key]: "calc" });
  expect(read).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
  root = createRoot(host);
  await render();
  expect([...host.querySelectorAll("button")].find(button => button.textContent === "计算失误")?.getAttribute("aria-pressed")).toBe("true");
  expect(host.textContent).toContain("不作为系统批改或掌握度依据");
});

it("offers a retry after a read failure instead of showing a successful empty list", async () => {
  read.mockRejectedValueOnce(new Error("易错点暂时无法读取"));
  await render();
  expect(host.textContent).toContain("易错点暂时无法读取");
  expect(host.textContent).not.toContain("还没有易错点");
  read.mockResolvedValue(result());
  await act(async () => host.querySelector<HTMLButtonElement>("button")?.click());
  expect(host.textContent).toContain("最近独立完成");
});

it("aborts a read when leaving the view and ignores a late result", async () => {
  let resolve!: (value: WeakPointsSummary) => void;
  read.mockReturnValue(new Promise<WeakPointsSummary>(done => { resolve = done; }));
  await render();
  const signal: AbortSignal = read.mock.calls[0]![0];
  await act(async () => root.render(<div>其他页面</div>));
  expect(signal.aborted).toBe(true);
  await act(async () => resolve(result()));
  expect(host.textContent).toBe("其他页面");
});
