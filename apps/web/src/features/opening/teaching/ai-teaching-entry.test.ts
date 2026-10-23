// @vitest-environment jsdom
/**
 * J1 / G8: lock the "AI 主讲" entry path (Today → teaching activity) so the
 * notes surface does not degrade it into read-materials / take-notes only.
 * Gating on 07862cf: dual flag (OPENING_TEACHING_LOOP && _WORKSPACE). PR-H
 * (e22ef8f) replaces this with server capabilities; then swap the gate input,
 * the expectations below stay.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TeachingActivity } from "@aistudy/contracts";
import type { OpeningApi } from "../client/api";
import { openingNavigation } from "../shell/navigation";
import { TeachingActivityEmpty } from "./activity-panel";
import { TeachingLoopTrialEmpty } from "./teaching-loop-trial-empty";
import { resolveTeachingLoopTrialGate } from "./teaching-loop-trial";
import { TodayDashboard } from "../planning/today-dashboard";
import { StartPage } from "../start/start-page";
import OpeningTodayPage from "../../../app/(opening)/opening/today/page";
import { loadTodayPage } from "../planning/load-today-page";

vi.mock("../planning/load-today-page", () => ({ loadTodayPage: vi.fn(async () => ({ state: { kind: "empty", courses: { status: "ready", items: [] } }, timeZone: "Etc/UTC" })) }));
vi.mock("../start/start-page", () => ({ StartPage: () => null }));
vi.mock("../cards/cards-client", () => ({ createOpeningCardsClient: () => ({ listDue: async () => [] }) }));
vi.mock("../planning/today-view", async importOriginal => ({
  ...await importOriginal<typeof import("../planning/today-view")>(),
  TodayPlanView: () => null,
}));

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals();
});

const activity: TeachingActivity = {
  id: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  ownerUserId: "33333333-3333-4333-8333-333333333333",
  courseId: null, status: "active", generateStatus: "queued", intentKind: "topic",
  intentSummary: "今日主题学习", sourceIds: [], pathVersion: 1, contentVersion: 0,
  clientKey: "today-topic:2026-10-11", createdAt: "2026-10-11T01:00:00.000Z", updatedAt: "2026-10-11T02:00:00.000Z",
};

async function renderToday(activities: TeachingActivity[], trialEnabled: boolean) {
  const api = {
    listTeachingActivities: vi.fn<OpeningApi["listTeachingActivities"]>().mockResolvedValue(activities),
    getTeachingResume: vi.fn<OpeningApi["getTeachingResume"]>(() => new Promise(() => {})),
    listTasks: vi.fn<OpeningApi["listTasks"]>().mockResolvedValue({ tasks: [] }),
    getToday: vi.fn<OpeningApi["getToday"]>(async date => ({ date, acceptedVersion: 0, blocks: [], hardBlocks: [] })),
  } satisfies Pick<OpeningApi, "listTeachingActivities" | "getTeachingResume" | "listTasks" | "getToday">;
  await act(async () => root.render(createElement(TodayDashboard, {
    state: { kind: "ready" }, api: api as unknown as OpeningApi, teachingLoopEnabled: true,
    teachingWorkspaceEnabled: trialEnabled, teachingLoopTrialEnabled: trialEnabled,
  })));
  expect(api.listTeachingActivities).toHaveBeenCalledOnce();
  expect(api.listTasks).toHaveBeenCalledOnce();
  expect(api.getToday).toHaveBeenCalledOnce();
  expect(container.querySelector('[aria-label="今天的进度"]')?.textContent).toContain("复习 · 0 项");
  expect(container.querySelector('a[href^="/opening/library"]')).toBeNull();
}

const webSrc = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(webSrc, p), "utf8");

describe("AI 主讲 entry path", () => {
  it("Today is the first core entry and notes is a separate core entry after the assistant", () => {
    const core = openingNavigation().filter((i) => i.group === "core").map((i) => i.href);
    expect(core[0]).toBe("/opening/today");
    expect(core).toContain("/opening/library");
    expect(core.indexOf("/opening/library")).toBeGreaterThan(core.indexOf("/opening/today"));
  });

  it("/opening/today passes the authenticated server state to the new learning entry", async () => {
    const page = await OpeningTodayPage({ searchParams: Promise.resolve({}) });
    expect(loadTodayPage).toHaveBeenCalledOnce();
    expect(page.type).toBe(StartPage);
    expect(page.props).toEqual({ state: { kind: "empty", courses: { status: "ready", items: [] } }, timeZone: "Etc/UTC" });
  });

  it.each([true, false])("Today keeps unscoped activity continuation honest when the trial gate is %s", async enabled => {
    await renderToday([activity], enabled);
    expect(container.querySelector("[data-teaching-continue-entry]")).toBeNull();
    expect(container.querySelector('[data-teaching-loop-trial-empty="true"]')).toBeNull();
    const entry = container.querySelector<HTMLButtonElement>('button[data-today-primary-cta="true"]');
    expect(entry).not.toBeNull();
    expect(entry!.disabled).toBe(false);
    container.querySelector<HTMLDivElement>('[data-today-teaching-pane="true"]')!.scrollIntoView = vi.fn();
    await act(async () => entry!.click());
    expect(container.querySelector('[data-teaching-continue-entry="card"]') !== null).toBe(enabled);
    expect(container.querySelector('[data-teaching-loop-trial-empty="true"]') !== null).toBe(!enabled);
    if (!enabled) expect(container.textContent).toContain("AI 主讲试运行未开启");
  });

  it("Today continues course activities in their course workspace", async () => {
    await renderToday([{ ...activity, courseId: "course-1" }], true);
    const entry = container.querySelector<HTMLAnchorElement>('a[data-today-primary-cta="true"]');
    expect(entry?.getAttribute("href")).toBe(`/opening/courses/course-1/study?activity=${activity.id}`);
    expect(entry?.textContent).toContain(activity.intentSummary);
    expect(container.querySelector("[data-teaching-continue-entry]")).toBeNull();
  });

  it("Today offers a course entry after confirming there is no activity to continue", async () => {
    await renderToday([], true);
    expect(container.textContent).toContain("从课程继续学习");
    expect(container.querySelector('a[href="/opening/courses"]')?.textContent).toBe("选择课程");
    expect(container.querySelector("[data-teaching-continue-entry]")).toBeNull();
  });

  it("gate open (both flags) → trial entry; any flag off → closed", () => {
    expect(resolveTeachingLoopTrialGate({ OPENING_TEACHING_LOOP: "1", OPENING_TEACHING_WORKSPACE: "1" }).trialEnabled).toBe(true);
    expect(resolveTeachingLoopTrialGate({ OPENING_TEACHING_LOOP: "1" }).trialEnabled).toBe(false);
    expect(resolveTeachingLoopTrialGate({}).trialEnabled).toBe(false);
  });

  it("no activity yet → primary CTA starts teaching; notes/materials are not the fallback", () => {
    const html = renderToStaticMarkup(createElement(TeachingActivityEmpty, { onStart: () => undefined }));
    expect(html).toContain("开始学习");
    expect(html).toContain("AI 主讲");
    expect(html).not.toContain("/opening/library");
  });

  it("gate closed → honest 'AI 主讲试运行未开启', not redirected into notes/materials", () => {
    const html = renderToStaticMarkup(createElement(TeachingLoopTrialEmpty, { loopEnabled: false, workspaceEnabled: true }));
    expect(html).toContain("AI 主讲试运行未开启");
    expect(html).toContain('data-loop-enabled="false"');
    expect(html).not.toContain("/opening/library");
  });

  it("notes entry routes stay inside the Opening shell", () => {
    expect(read("app/(opening)/opening/library/[id]/page.tsx")).toMatch(/basePath="\/opening\/library"/);
    expect(read("app/(opening)/opening/library/new/page.tsx")).toMatch(/basePath="\/opening\/library"/);
  });
});
