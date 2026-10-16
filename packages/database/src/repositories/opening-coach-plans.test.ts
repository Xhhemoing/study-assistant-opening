import { describe, expect, it } from "vitest";
import type { TransactionSql } from "postgres";
import { assertCoachAcceptance } from "./opening-coach-plans";
import type { PlannedBlock, SuggestedTask } from "@aistudy/contracts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const day = "2026-10-21", now = new Date(`${day}T08:00:00Z`), scope = { workspaceId: id(1), ownerUserId: id(2) };
const suggestion = (n: number, minutes: number): SuggestedTask => ({ id: id(n), key: `planner:${day}:weak_skill:${id(99)}:${n}`, kind: "weak_skill",
  title: "复习", minutes, courseId: id(99), skillLabel: "矩阵乘法", reasonCode: "weak_skill", reason: "无提示练习" });
const block = (taskId: string, minutes: number, offset = 0): PlannedBlock => ({ taskId, start: new Date(Date.parse(`${day}T09:00:00Z`) + offset * 60_000).toISOString(),
  end: new Date(Date.parse(`${day}T09:00:00Z`) + (offset + minutes) * 60_000).toISOString(), reason: "排程" });
function tx(prefs: object = {}, active = false): TransactionSql {
  return ((query: TemplateStringsArray | string[]) => {
    if (!("raw" in query)) return query;
    return Promise.resolve(query.join("").includes("workspace_preferences")
      ? [{ adaptive_planning: { autonomy: "coach", coachBudgetMinutes: 30, courseGoals: {}, coachAutoAcceptEnabled: true, ...prefs }, planning_settings: {
        weekOneMonday: "2026-10-19", periodTimes: {}, dailyWindow: { start: "08:00", end: "12:00" }, lunch: { start: "12:00", end: "13:00" },
        dinner: { start: "17:30", end: "18:30" }, sleep: { start: "23:00", end: "07:00" }, timeZone: "Etc/UTC" } }]
      : active ? [{ id: id(90) }] : []);
  }) as unknown as TransactionSql;
}
function input(extra: object = {}) {
  const suggestions = [suggestion(3, 20), suggestion(4, 20)];
  return { day, draft: { status: "draft", origin: "auto_draft", version: 0, base_version: 0, suggested_tasks: suggestions },
    state: { accepted_version: 0 }, blocks: suggestions.map((item, index) => block(item.id, item.minutes, index * 30)), now, expectedDraftVersion: 0, ...extra };
}
describe("server coach policy", () => {
  it("selects only suggestions that fit the current server budget", async () => {
    expect(await assertCoachAcceptance(tx(), scope, input())).toEqual({ acceptKeys: [suggestion(3, 20).key], scheduledMinutes: 20 });
  });
  it("deducts existing task time before selecting suggestions", async () => {
    const value = input(); value.blocks.push(block(id(9), 20, 90));
    expect(await assertCoachAcceptance(tx(), scope, value)).toEqual({ acceptKeys: [], scheduledMinutes: 20 });
  });
  it.each([{ autonomy: "manual" }, { autonomy: "copilot" }, { coachAutoAcceptEnabled: false }, { coachAutoAcceptEnabled: undefined }])("requires explicit saved permission %j", async prefs => {
    await expect(assertCoachAcceptance(tx(prefs), scope, input())).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("refuses other days, existing plans, model drafts and stale versions", async () => {
    for (const change of [{ day: "2026-10-22" }, { state: { accepted_version: 1 } },
      { draft: { ...input().draft, origin: "agent" } }, { expectedDraftVersion: 1 }, { blocks: [] }]) {
      await expect(assertCoachAcceptance(tx(), scope, input(change))).rejects.toMatchObject({ code: "CONFLICT" });
    }
  });
  it("refuses already active task learning", async () => {
    await expect(assertCoachAcceptance(tx({}, true), scope, input())).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("leaves card review suggestions for learner confirmation", async () => {
    const value = input();
    value.draft.suggested_tasks = value.draft.suggested_tasks.map(item => ({ ...item, kind: "review_cards", reasonCode: "review_cards" }));
    await expect(assertCoachAcceptance(tx(), scope, value)).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
