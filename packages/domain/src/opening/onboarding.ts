import { DEFAULT_OPENING_PLANNING_SETTINGS, type OpeningOnboardingInput, type OpeningPlanningSettings } from "@aistudy/contracts";
import { getScenarioPresetDefinition } from "../planning/scenario-presets";

/** Seed learning actions, not a fictitious diagnosis. No model or answer key is involved. */
export function buildOpeningOnboardingSeed(input: Extract<OpeningOnboardingInput, { action: "complete" }>, now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: input.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const date = ["year", "month", "day"].map(type => parts.find(p => p.type === type)!.value).join("-");
  if (input.examDate && input.examDate < date) throw new RangeError("考试日期已过；可留空并从当前主题开始。");
  const monday = new Date(`${date}T00:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  const preset = getScenarioPresetDefinition(input.scenario);
  const settings: OpeningPlanningSettings = { ...DEFAULT_OPENING_PLANNING_SETTINGS,
    weekOneMonday: monday.toISOString().slice(0, 10), timeZone: input.timeZone, dailyWindow: { start: "20:00", end: "21:00" } };
  return { settings, presetVersion: preset.version, goal: { subject: input.subject, scenario: input.scenario, examDate: input.examDate,
    timeZone: input.timeZone, sourceIds: input.sourceIds, status: "unobserved", baselineReason: preset.reasonByStatus.untested },
    tasks: [
      { title: `${input.subject}：独立试做一道基线题，记录不确定处`, minutes: 10, priority: 3 },
      { title: `${input.subject}：结合材料学习一个概念与例题`, minutes: 15, priority: 2 },
      { title: `${input.subject}：独立完成一道变式并整理疑问`, minutes: 15, priority: 1 },
    ] };
}
