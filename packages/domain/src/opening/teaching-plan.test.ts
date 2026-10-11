import { describe, expect, it } from "vitest";
import {
  ALLOWED_TEACHING_BLOCK_TYPES,
  assertOutlineHonest,
  assertTeachingPathNotPlanDay,
  decideHistoryFreeze,
  normalizeBlockTypes,
  suggestPrerequisites,
  type TeachingOutline,
} from "./teaching-plan";

function sampleOutline(overrides: Partial<TeachingOutline> = {}): TeachingOutline {
  return {
    outlineId: "ol-1",
    activityId: "act-1",
    focusItemId: "item-2",
    kind: "teaching_path",
    items: [
      {
        itemId: "item-1",
        title: "Hook",
        goalIds: ["g1"],
        intendedBlockTypes: ["text", "prompt"],
        sourceIds: ["src-a"],
      },
      {
        itemId: "item-2",
        title: "Define",
        goalIds: ["g2"],
        intendedBlockTypes: ["text", "formula", "matrix-viz", "unknown-html"],
        sourceIds: ["src-a"],
        prereqItemIds: ["item-1"],
      },
    ],
    prereqs: [],
    ...overrides,
  };
}

describe("teaching-plan", () => {
  it("C8/allowlist: normalizeBlockTypes clamps unknown and maps matrix-viz", () => {
    expect(normalizeBlockTypes(["text", "matrix-viz", "evil-script", "formula", "text"])).toEqual([
      "text",
      "formula",
    ]);
    expect(normalizeBlockTypes([])).toEqual(["text"]);
    expect(ALLOWED_TEACHING_BLOCK_TYPES).toContain("answer_key");
    expect(ALLOWED_TEACHING_BLOCK_TYPES).not.toContain("matrix-viz");
  });

  it("C3: assertTeachingPathNotPlanDay rejects DayPlanResult calendar shape", () => {
    expect(() =>
      assertTeachingPathNotPlanDay({
        blocks: [
          {
            taskId: "00000000-0000-4000-8000-000000000001",
            start: "2026-10-11T01:00:00.000Z",
            end: "2026-10-11T02:00:00.000Z",
            reason: "due soon",
          },
        ],
        unscheduledTaskIds: [],
      }),
    ).toThrow(/planDay|calendar/i);

    expect(() => assertTeachingPathNotPlanDay({ kind: "plan_day" })).toThrow(/planDay|calendar/i);

    expect(() =>
      assertTeachingPathNotPlanDay({
        focusItemId: "x",
        items: [],
        kind: "calendar",
      }),
    ).toThrow();

    expect(() => assertTeachingPathNotPlanDay(sampleOutline())).not.toThrow();
  });

  it("C4: prereq suggestions are skippable with human reason; no mastery %", () => {
    const outline = sampleOutline();
    const prereqs = suggestPrerequisites(outline);
    expect(prereqs.length).toBeGreaterThan(0);
    for (const p of prereqs) {
      expect(p.skippable).toBe(true);
      expect(p.reason.length).toBeGreaterThan(0);
      expect(p).not.toHaveProperty("mastery");
      expect(p).not.toHaveProperty("masteryPercent");
    }
    const honest = { ...outline, prereqs };
    expect(() => assertOutlineHonest(honest)).not.toThrow();
  });

  it("C4: assertOutlineHonest rejects non-skippable prereq and mastery keys", () => {
    expect(() =>
      assertOutlineHonest(
        sampleOutline({
          prereqs: [
            {
              itemId: "item-1",
              reason: "locked",
              skippable: false as unknown as true,
              skipEffect: "continue_without",
            },
          ],
        }),
      ),
    ).toThrow(/skippable/);

    expect(() =>
      assertOutlineHonest({
        ...sampleOutline(),
        masteryPercent: 80,
      } as unknown as TeachingOutline),
    ).toThrow(/mastery/i);
  });

  it("C5: goal adjust freezes learned history (revise_subsequent_only)", () => {
    const outline = sampleOutline({ focusItemId: "item-2" });
    const decision = decideHistoryFreeze({
      outline,
      publishedActivityIds: ["item-1", "item-2"],
      learnedActivityIds: ["item-1"],
      goalAdjustment: true,
    });
    expect(decision).toEqual({
      action: "revise_subsequent_only",
      frozenActivityIds: ["item-1"],
      reviseFromItemId: "item-2",
    });
  });

  it("C5: rewriting a learned focus without goal-adjust is rejected", () => {
    const decision = decideHistoryFreeze({
      outline: sampleOutline({ focusItemId: "item-1" }),
      publishedActivityIds: ["item-1"],
      learnedActivityIds: ["item-1"],
      goalAdjustment: false,
    });
    expect(decision.action).toBe("reject_rewrite_history");
  });

  it("compile_current when no goal adjust and focus not learned", () => {
    const decision = decideHistoryFreeze({
      outline: sampleOutline(),
      publishedActivityIds: [],
      learnedActivityIds: [],
      goalAdjustment: false,
    });
    expect(decision).toEqual({ action: "compile_current", targetItemId: "item-2" });
  });

  it("assertOutlineHonest normalizes block types on items", () => {
    const outline = sampleOutline();
    assertOutlineHonest(outline);
    const focus = outline.items.find((i) => i.itemId === "item-2")!;
    expect(focus.intendedBlockTypes).toEqual(["text", "formula"]);
    expect(focus.intendedBlockTypes).not.toContain("matrix-viz");
    expect(focus.intendedBlockTypes).not.toContain("unknown-html");
  });
});
