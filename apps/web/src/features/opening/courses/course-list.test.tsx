// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_OPENING_ADAPTIVE_PREFS, type CourseGoal } from "@aistudy/contracts";
import type { CourseSummary } from "./course-model";
vi.mock("../v3/motion/view-transition", () => ({ TransitionLink: ({ href, children, className }: { href: string; children: ReactNode; className?: string }) => <a href={href} className={className}>{children}</a> }));
import { CourseList } from "./course-list";

const id = "11111111-1111-4111-8111-111111111111";
const archivedId = "22222222-2222-4222-8222-222222222222";
const course: CourseSummary = { id, title: "进行中数学", slug: "math", description: "", createdAt: "2026-10-15", updatedAt: "2026-10-15" };
const archived = { ...course, id: archivedId, title: "归档物理", archivedAt: "2026-10-15" };
const exam: CourseGoal = { targetDate: "2026-11-01", weeklyMinutes: 120, learningMode: "exam" };
const prefs = (goal: CourseGoal | null = exam, invalidStoredPrefs = false) => ({ prefs: { ...DEFAULT_OPENING_ADAPTIVE_PREFS, courseGoals: goal ? { [id]: goal, [archivedId]: goal } : {} }, saved: true, invalidStoredPrefs });
let host: HTMLDivElement, root: Root;
let courses: CourseSummary[];
let readPrefs: () => Promise<Response>;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  courses = [course, archived]; readPrefs = async () => Response.json(prefs());
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url === "/api/opening/adaptive-planning" ? readPrefs() : Response.json({ courses })));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const render = async (opening = true) => { await act(async () => root.render(<CourseList opening={opening} />)); };
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === text)!;
const sprint = () => host.querySelector<HTMLAnchorElement>('a[href^="/opening/sprint?"]');
const prefReads = () => vi.mocked(fetch).mock.calls.filter(call => call[0] === "/api/opening/adaptive-planning");

it("keeps course creation inside the Opening route", async () => {
  await render();
  expect(host.querySelector('a[href="/opening/courses/new"]')).not.toBeNull();
  expect(host.querySelector('a[href="/learn/courses/new"]')).toBeNull();
});

it("clears an unmatched search and restores courses in the current category", async () => {
  await render();
  await act(async () => button("已归档").click());
  const input = host.querySelector<HTMLInputElement>('[aria-label="搜索课程"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "没有这个课程");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(host.textContent).toContain("没有匹配的课程");
  await act(async () => button("清空搜索").click());
  expect(host.textContent).toContain("归档物理");
  expect(host.textContent).not.toContain("进行中数学");
  expect(sprint()).toBeNull();
});

it("keeps the first-course action for a truly empty workspace", async () => {
  courses = [];
  await render();
  expect(host.textContent).toContain("创建第一门课程");
  expect(host.textContent).not.toContain("清空搜索");
});

it("offers an independent course menu with the canonical sprint link in both layouts", async () => {
  await render();
  expect(prefReads()).toHaveLength(1);
  expect(host.querySelector('summary[aria-label="进行中数学更多操作"]')).not.toBeNull();
  expect(sprint()?.getAttribute("href")).toBe(`/opening/sprint?courseId=${id}`);
  expect(sprint()?.textContent).toBe("考前冲刺");
  expect(sprint()?.parentElement?.closest("a")).toBeNull();
  const details = sprint()!.closest("details")!;
  expect(details.open).toBe(false);
  await act(async () => details.querySelector("summary")!.click());
  expect(details.open).toBe(true);
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="卡片视图"]')!.click());
  expect(sprint()?.getAttribute("href")).toBe(`/opening/sprint?courseId=${id}`);
  expect(host.querySelector('[aria-label="卡片视图"]')?.getAttribute("aria-pressed")).toBe("true");
  expect(prefReads()).toHaveLength(1);
});

it.each([
  { ...exam, learningMode: "auto" as const },
  { ...exam, learningMode: "understand" as const },
  { targetDate: exam.targetDate, weeklyMinutes: 120 },
  { ...exam, targetDate: null },
  null,
])("does not present generic goals or missing exam dates as an exam", async goal => {
  readPrefs = async () => Response.json(prefs(goal));
  await render();
  expect(sprint()).toBeNull();
  expect(host.querySelector('a[href="/opening/courses/' + id + '"]')).not.toBeNull();
});

it.each(["pending", "invalid", "failure", "malformed"])("keeps courses usable without an exam menu when goals are %s", async kind => {
  readPrefs = kind === "pending" ? () => new Promise(() => {}) : kind === "failure" ? async () => { throw new Error("offline"); }
    : async () => Response.json(kind === "invalid" ? prefs(exam, true) : { prefs: "broken" });
  await render();
  expect(sprint()).toBeNull();
  expect(host.textContent).toContain("进行中数学");
  expect(host.querySelector('a[href="/opening/courses/' + id + '"]')).not.toBeNull();
});

it("does not read or show Opening goal actions on the legacy course route", async () => {
  await render(false);
  expect(prefReads()).toHaveLength(0);
  expect(sprint()).toBeNull();
  expect(host.querySelector('a[href="/learn/courses/' + id + '"]')).not.toBeNull();
});

it("ignores old goal responses across Opening mode changes", async () => {
  let resolveOld!: (response: Response) => void;
  readPrefs = () => new Promise(resolve => { resolveOld = resolve; });
  await render();
  await render(false);
  readPrefs = async () => Response.json(prefs(null));
  await render();
  await act(async () => resolveOld(Response.json(prefs())));
  expect(prefReads()).toHaveLength(2);
  expect(sprint()).toBeNull();
});

it("ignores a goal response from an unmounted course list", async () => {
  let resolveOld!: (response: Response) => void;
  readPrefs = () => new Promise(resolve => { resolveOld = resolve; });
  await render();
  await act(async () => root.render(null));
  readPrefs = async () => Response.json(prefs(null));
  await render();
  await act(async () => resolveOld(Response.json(prefs())));
  expect(prefReads()).toHaveLength(2);
  expect(sprint()).toBeNull();
});
