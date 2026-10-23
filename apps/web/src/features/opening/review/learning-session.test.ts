import { describe, expect, it } from "vitest";
import { sessionNext } from "./review-hub";
import { friendlyTodayLabel, todaySessionHref } from "../planning/today-dashboard";
import { stepLabels } from "../teaching/span/span-lesson";

const STUDY = "/opening/courses/11111111-1111-4111-8111-111111111111/study?activity=22222222-2222-4222-8222-222222222222";

describe("one-tap learning session (F1)", () => {
  it("chains mixed review into the current study unit", () => {
    const href = todaySessionHref({ href: STUDY, label: "线性组合与 span" });
    const params = new URL(href, "https://x.invalid").searchParams;
    expect(href.startsWith("/opening/review?")).toBe(true);
    expect(params.get("tab")).toBe("session");
    expect(sessionNext(`?${params}`)).toEqual({ href: STUDY, label: "线性组合与 span" });
  });

  it("refuses next targets outside course study", () => {
    expect(sessionNext("?next=https%3A%2F%2Fevil.example")).toBeUndefined();
    expect(sessionNext("?next=%2Fopening%2Fsettings")).toBeUndefined();
    expect(sessionNext("?tab=session")).toBeUndefined();
    expect(sessionNext(`?next=${encodeURIComponent(STUDY)}`)?.label).toBe("继续学习");
  });
});

describe("v4 labels", () => {
  it("formats today in Chinese month/day/weekday", () => {
    expect(friendlyTodayLabel(new Date("2026-10-23T12:00:00Z"), "UTC")).toMatch(/10月23日.*周五/);
  });

  it("disambiguates repeated independent-problem steps", () => {
    const kinds = ["worked_example", "faded_example", "independent", "independent"].map(kind => ({ presentation: { kind } }));
    expect(stepLabels(kinds)).toEqual(["逐步看例题", "补全步骤", "独立新题", "迁移新题"]);
  });
});
