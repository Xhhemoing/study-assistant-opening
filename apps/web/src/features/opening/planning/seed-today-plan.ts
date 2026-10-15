import {
  type OpeningPlanningSettings,
  type OpeningPlanningSettingsResponse,
  type TaskCreateInput,
  taskCreateInputSchema,
} from "@aistudy/contracts";
import { addLocalDays, localDateKeyInZone } from "@aistudy/domain";
import { OpeningApiError, type OpeningApi } from "../client/api";
import { blankSemesterDraft, PERIOD_45MIN_TEMPLATE } from "../timetable/semester-settings-form";

export const SEED_TODAY_TIME_ZONE = "Asia/Shanghai";
export const SEED_TODAY_MINUTES = 25;
export const SEED_TODAY_HREF = "/opening/today";

/**
 * Most recent Monday on or before `localDate` (YYYY-MM-DD calendar math).
 * Inclusive of today when today is Monday.
 */
export function mostRecentMondayInclusive(localDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
    throw new RangeError(`invalid localDate: ${localDate}`);
  }
  const utc = new Date(`${localDate}T00:00:00Z`);
  if (Number.isNaN(utc.getTime())) {
    throw new RangeError(`invalid localDate: ${localDate}`);
  }
  const dow = utc.getUTCDay(); // 0 Sun … 1 Mon
  const daysBack = dow === 0 ? 6 : dow - 1;
  return addLocalDays(localDate, -daysBack);
}

/** Default planning settings for Opening cold-start seed (self-study schedule). */
export function buildSeedSettings(
  now: Date = new Date(),
  timeZone: string = SEED_TODAY_TIME_ZONE,
): OpeningPlanningSettings {
  const localDate = localDateKeyInZone(now, timeZone);
  const draft = blankSemesterDraft(timeZone);
  return {
    ...draft,
    weekOneMonday: mostRecentMondayInclusive(localDate),
    periodTimes: { ...PERIOD_45MIN_TEMPLATE },
    timeZone,
  };
}

export function needsPlanningSettingsSeed(
  response: OpeningPlanningSettingsResponse,
): boolean {
  return response.settings == null || response.invalidStoredSettings;
}

export function buildCourseSeedTaskInput(
  courseId: string,
  courseTitle: string,
  localDate: string,
): TaskCreateInput {
  const title = `${courseTitle.trim()} · 今日主题`;
  return taskCreateInputSchema.parse({
    title,
    minutes: SEED_TODAY_MINUTES,
    dueAt: null,
    priority: 1,
    candidateId: null,
    clientKey: `course-seed:${courseId}:${localDate}`,
    // Binds the task's lessons to the course and its materials.
    courseId,
  });
}

export function buildDefaultSeedTaskInput(localDate: string): TaskCreateInput {
  return taskCreateInputSchema.parse({
    title: "今日自学 · 25 分钟",
    minutes: SEED_TODAY_MINUTES,
    dueAt: null,
    priority: 1,
    candidateId: null,
    clientKey: `default-seed:${localDate}`,
  });
}

export type SeedTodayPlanTarget =
  | { kind: "course"; courseId: string; courseTitle: string }
  | { kind: "default" };

export type SeedTodayPlanApi = Pick<
  OpeningApi,
  "getPlanningSettings" | "putPlanningSettings" | "createTask"
>;

/**
 * Client composition: ensure valid planning settings, create one seed task
 * (409 / same-clientKey replay = success), optionally navigate to Today.
 */
export async function runSeedTodayPlan(
  api: SeedTodayPlanApi,
  options: {
    target: SeedTodayPlanTarget;
    now?: Date;
    timeZone?: string;
    navigate?: (href: string) => void;
  },
): Promise<void> {
  const timeZone = options.timeZone ?? SEED_TODAY_TIME_ZONE;
  const now = options.now ?? new Date();
  const localDate = localDateKeyInZone(now, timeZone);

  const current = await api.getPlanningSettings();
  if (needsPlanningSettingsSeed(current)) {
    await api.putPlanningSettings(buildSeedSettings(now, timeZone));
  }

  const input =
    options.target.kind === "course"
      ? buildCourseSeedTaskInput(
          options.target.courseId,
          options.target.courseTitle,
          localDate,
        )
      : buildDefaultSeedTaskInput(localDate);

  try {
    await api.createTask(input);
  } catch (reason) {
    // Replay of the same clientKey may surface as 200 (handled by createTask)
    // or 409 when the server treats the key as a conflict — both are success.
    if (!(reason instanceof OpeningApiError && reason.status === 409)) {
      throw reason;
    }
  }

  options.navigate?.(SEED_TODAY_HREF);
}
