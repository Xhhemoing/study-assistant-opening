import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { OpeningPlanningSettings } from "@aistudy/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CourseLearningView } from "../opening/learning/course-view";
import { OpeningApiError } from "../opening/client/api";
import { PERIOD_45MIN_TEMPLATE } from "../opening/timetable/semester-settings-form";
import { runSeedTodayPlan } from "../opening/planning/seed-today-plan";

const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, className }: { href: string; children?: unknown; className?: string }) =>
    createElement("a", { href, className }, children as never),
}));

import { CourseStudyActions } from "./course-study-actions";

const COURSE_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

beforeEach(() => {
  push.mockReset();
});

it("keeps a single primary practice CTA without competing materials CTA (CT-01/02)", () => {
  const html = renderToStaticMarkup(createElement(CourseStudyActions, { assetCount: 0, goalCount: 0 }));
  expect(html).toContain('href="#course-practice"');
  expect(html).toContain("开始独立练习");
  expect(html).toContain('href="/library/new"');
  expect(html).not.toContain('href="#course-assets"');
  expect(html).toContain("从第一个主题开始");
  expect(html).not.toContain("设为今日计划");
  expect(html).not.toMatch(/\s(?:aria-)?disabled(?:=|>)/u);
});

it("keeps Opening note actions under the Opening library", () => {
  const html = renderToStaticMarkup(createElement(CourseStudyActions, { assetCount: 0, goalCount: 0, opening: true }));
  expect(html).toContain('href="/opening/library/new"');
  expect(html).not.toContain('href="/library/new"');
});

it("makes actual study primary and keeps plan seeding as a visible secondary action", () => {
  const html = renderToStaticMarkup(
    createElement(CourseStudyActions, {
      assetCount: 1,
      opening: true,
      courseId: COURSE_ID,
      courseTitle: "高等数学",
    }),
  );
  expect(html).toContain("设为今日计划");
  expect(html).toContain(`href="/opening/courses/${COURSE_ID}/study"`);
  expect(html).toContain("开始独立练习");
  expect(html.indexOf("开始独立练习")).toBeLessThan(html.indexOf("设为今日计划"));
  expect(html).not.toContain("<details");
});

it("links practice and record actions to existing sections while records are still loading", () => {
  const html = renderToStaticMarkup(createElement(CourseLearningView, { courseId: "course" }));
  expect(html).toContain('id="course-practice"');
  expect(html).toContain('id="course-learning-records"');
  expect(html).toContain("开始本次练习");
  expect(html).toContain("保存后自动批改，判错了可以直接更正");
  expect(html).toContain("题目材料与题干（用于 AI 批改）");
  expect(html.indexOf('id="course-practice"')).toBeLessThan(html.indexOf('id="course-learning-records"'));
});

it("omits the goal counter when Opening hides goal data", () => {
  const html = renderToStaticMarkup(createElement(CourseStudyActions, { assetCount: 0, opening: true }));
  expect(html).not.toContain("个学习目标");
  expect(html).toContain("0 份课程材料");
});

describe("Opening seed CTA composition", () => {
  it("calls put settings + createTask then navigates (mock api)", async () => {
    const putPlanningSettings = vi.fn(async (settings: OpeningPlanningSettings) => ({
      settings,
      saved: true,
      invalidStoredSettings: false,
    }));
    const createTask = vi.fn(async (input: { title: string; minutes: number; dueAt: null; priority: number; candidateId: null; clientKey?: string }) => ({
      id: COURSE_ID,
      title: input.title,
      minutes: input.minutes,
      dueAt: null,
      priority: 1,
      status: "pending" as const,
    }));
    const api = {
      getPlanningSettings: vi.fn(async () => ({
        settings: null,
        saved: false,
        invalidStoredSettings: false,
      })),
      putPlanningSettings,
      createTask,
    };
    const navigate = vi.fn();

    await runSeedTodayPlan(api, {
      target: { kind: "course", courseId: COURSE_ID, courseTitle: "高等数学" },
      now: new Date("2026-10-14T06:00:00.000Z"),
      navigate,
    });

    expect(putPlanningSettings).toHaveBeenCalledOnce();
    expect(putPlanningSettings.mock.calls[0]![0]).toMatchObject({
      weekOneMonday: "2026-10-12",
      periodTimes: PERIOD_45MIN_TEMPLATE,
      timeZone: "Asia/Shanghai",
    });
    expect(createTask).toHaveBeenCalledWith({
      title: "高等数学 · 今日主题",
      minutes: 25,
      dueAt: null,
      priority: 1,
      candidateId: null,
      clientKey: `course-seed:${COURSE_ID}:2026-10-14`,
      courseId: COURSE_ID,
      origin: "course_seed",
    });
    expect(navigate).toHaveBeenCalledWith("/opening/today");
  });

  it("treats createTask 409 as success for the same clientKey", async () => {
    const navigate = vi.fn();
    await runSeedTodayPlan(
      {
        getPlanningSettings: vi.fn(async () => ({
          settings: null,
          saved: false,
          invalidStoredSettings: false,
        })),
        putPlanningSettings: vi.fn(async (settings) => ({
          settings,
          saved: true,
          invalidStoredSettings: false,
        })),
        createTask: vi.fn(async () => {
          throw new OpeningApiError(409, "replay");
        }),
      },
      {
        target: { kind: "course", courseId: COURSE_ID, courseTitle: "高等数学" },
        now: new Date("2026-10-14T06:00:00.000Z"),
        navigate,
      },
    );
    expect(navigate).toHaveBeenCalledWith("/opening/today");
  });
});

it.each(["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"])("opens a new course-bound note for %s", courseId => {
  const html = renderToStaticMarkup(createElement(CourseStudyActions, { assetCount: 0, opening: true, courseId, courseTitle: "本课" }));
  expect(html).toContain(`href="/opening/library/new?courseId=${courseId}"`);
});
