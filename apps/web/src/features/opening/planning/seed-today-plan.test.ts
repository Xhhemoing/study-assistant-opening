import { describe, expect, it, vi } from "vitest";
import { OpeningApiError } from "../client/api";
import { PERIOD_45MIN_TEMPLATE } from "../timetable/semester-settings-form";
import {
  buildCourseSeedTaskInput,
  buildDefaultSeedTaskInput,
  buildSeedSettings,
  mostRecentMondayInclusive,
  needsPlanningSettingsSeed,
  runSeedTodayPlan,
  SEED_TODAY_HREF,
  type SeedTodayPlanApi,
} from "./seed-today-plan";

const COURSE_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

describe("mostRecentMondayInclusive", () => {
  it("returns the same day when localDate is Monday", () => {
    expect(mostRecentMondayInclusive("2026-10-12")).toBe("2026-10-12");
  });

  it("walks back to Monday for mid-week and Sunday", () => {
    // 2026-10-14 is Wednesday → Monday 2026-10-12
    expect(mostRecentMondayInclusive("2026-10-14")).toBe("2026-10-12");
    // 2026-10-18 is Sunday → Monday 2026-10-12
    expect(mostRecentMondayInclusive("2026-10-18")).toBe("2026-10-12");
    // 2026-10-13 is Tuesday → Monday 2026-10-12
    expect(mostRecentMondayInclusive("2026-10-13")).toBe("2026-10-12");
  });

  it("rejects non YYYY-MM-DD input", () => {
    expect(() => mostRecentMondayInclusive("10/14/2026")).toThrow(/invalid localDate/);
  });
});

describe("buildSeedSettings", () => {
  it("fills weekOneMonday + 45min periods from blankSemesterDraft defaults", () => {
    // 2026-10-14T06:00Z = 2026-10-14 14:00 Asia/Shanghai (Wednesday)
    const settings = buildSeedSettings(new Date("2026-10-14T06:00:00.000Z"), "Asia/Shanghai");
    expect(settings.weekOneMonday).toBe("2026-10-12");
    expect(settings.periodTimes).toEqual(PERIOD_45MIN_TEMPLATE);
    expect(settings.timeZone).toBe("Asia/Shanghai");
    expect(settings.dailyWindow).toEqual({ start: "07:30", end: "22:30" });
    expect(settings.lunch).toEqual({ start: "12:00", end: "13:00" });
    expect(settings.dinner).toEqual({ start: "17:30", end: "18:30" });
    expect(settings.sleep).toEqual({ start: "23:00", end: "07:00" });
  });

  it("uses Monday itself when now falls on Monday in the zone", () => {
    // 2026-10-12T02:00Z = 2026-10-12 10:00 Asia/Shanghai (Monday)
    const settings = buildSeedSettings(new Date("2026-10-12T02:00:00.000Z"), "Asia/Shanghai");
    expect(settings.weekOneMonday).toBe("2026-10-12");
  });
});

describe("buildCourseSeedTaskInput", () => {
  it("shapes title, minutes, and course-seed clientKey", () => {
    const input = buildCourseSeedTaskInput(COURSE_ID, "高等数学", "2026-10-14");
    expect(input).toEqual({
      title: "高等数学 · 今日主题",
      minutes: 25,
      dueAt: null,
      priority: 1,
      candidateId: null,
      clientKey: `course-seed:${COURSE_ID}:2026-10-14`,
    });
  });
});

describe("buildDefaultSeedTaskInput", () => {
  it("shapes default self-study task and clientKey", () => {
    expect(buildDefaultSeedTaskInput("2026-10-14")).toEqual({
      title: "今日自学 · 25 分钟",
      minutes: 25,
      dueAt: null,
      priority: 1,
      candidateId: null,
      clientKey: "default-seed:2026-10-14",
    });
  });
});

describe("needsPlanningSettingsSeed", () => {
  it("seeds when settings are missing or invalid", () => {
    expect(needsPlanningSettingsSeed({ settings: null, saved: false, invalidStoredSettings: false })).toBe(true);
    expect(needsPlanningSettingsSeed({
      settings: null,
      saved: true,
      invalidStoredSettings: true,
    })).toBe(true);
    const valid = buildSeedSettings(new Date("2026-10-14T06:00:00.000Z"));
    expect(needsPlanningSettingsSeed({
      settings: valid,
      saved: true,
      invalidStoredSettings: false,
    })).toBe(false);
    expect(needsPlanningSettingsSeed({
      settings: valid,
      saved: true,
      invalidStoredSettings: true,
    })).toBe(true);
  });
});

describe("runSeedTodayPlan", () => {
  function mockApi(overrides: Partial<SeedTodayPlanApi> = {}): SeedTodayPlanApi {
    return {
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
      createTask: vi.fn(async (input) => ({
        id: COURSE_ID,
        title: input.title,
        minutes: input.minutes,
        dueAt: null,
        priority: 1,
        status: "pending" as const,
      })),
      ...overrides,
    };
  }

  it("PUTs default settings then creates course task and navigates", async () => {
    const api = mockApi();
    const navigate = vi.fn();
    await runSeedTodayPlan(api, {
      target: { kind: "course", courseId: COURSE_ID, courseTitle: "高等数学" },
      now: new Date("2026-10-14T06:00:00.000Z"),
      navigate,
    });

    expect(api.getPlanningSettings).toHaveBeenCalledOnce();
    expect(api.putPlanningSettings).toHaveBeenCalledOnce();
    const putBody = vi.mocked(api.putPlanningSettings).mock.calls[0]![0];
    expect(putBody.weekOneMonday).toBe("2026-10-12");
    expect(putBody.periodTimes).toEqual(PERIOD_45MIN_TEMPLATE);

    expect(api.createTask).toHaveBeenCalledWith({
      title: "高等数学 · 今日主题",
      minutes: 25,
      dueAt: null,
      priority: 1,
      candidateId: null,
      clientKey: `course-seed:${COURSE_ID}:2026-10-14`,
    });
    expect(navigate).toHaveBeenCalledWith(SEED_TODAY_HREF);
  });

  it("skips PUT when valid settings already exist", async () => {
    const existing = buildSeedSettings(new Date("2026-10-14T06:00:00.000Z"));
    const api = mockApi({
      getPlanningSettings: vi.fn(async () => ({
        settings: existing,
        saved: true,
        invalidStoredSettings: false,
      })),
    });
    await runSeedTodayPlan(api, {
      target: { kind: "course", courseId: COURSE_ID, courseTitle: "高等数学" },
      now: new Date("2026-10-14T06:00:00.000Z"),
    });
    expect(api.putPlanningSettings).not.toHaveBeenCalled();
    expect(api.createTask).toHaveBeenCalledOnce();
  });

  it("treats createTask 409 as success and still navigates", async () => {
    const api = mockApi({
      createTask: vi.fn(async () => {
        throw new OpeningApiError(409, "clientKey replay");
      }),
    });
    const navigate = vi.fn();
    await runSeedTodayPlan(api, {
      target: { kind: "default" },
      now: new Date("2026-10-14T06:00:00.000Z"),
      navigate,
    });
    expect(navigate).toHaveBeenCalledWith(SEED_TODAY_HREF);
  });

  it("rethrows non-409 createTask failures", async () => {
    const api = mockApi({
      createTask: vi.fn(async () => {
        throw new OpeningApiError(500, "boom");
      }),
    });
    await expect(runSeedTodayPlan(api, {
      target: { kind: "default" },
      now: new Date("2026-10-14T06:00:00.000Z"),
    })).rejects.toMatchObject({ status: 500 });
  });
});
