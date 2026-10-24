import { describe, expect, it } from "vitest";
import type { TeachingOutline } from "@aistudy/domain";
import { readStoredTeachingOutline } from "./teaching-outline";

const outline = (): TeachingOutline => ({ kind: "teaching_path", outlineId: "saved", activityId: "activity",
  focusItemId: "real", items: [
    { itemId: "real", title: "实数", goalIds: ["goal"], intendedBlockTypes: ["text", "prompt"], sourceIds: ["source"], notes: "保留已编辑目标" },
    { itemId: "inverse", title: "反函数", goalIds: ["goal2"], intendedBlockTypes: ["text"], sourceIds: ["source"] },
  ], prereqs: [] });

describe("stored teaching outline boundary", () => {
  it("keeps old specs without an outline compatible", () => {
    expect(readStoredTeachingOutline(undefined, "activity", ["source"])).toBeNull();
    expect(readStoredTeachingOutline(null, "activity", [])).toBeNull();
  });
  it("reads the persisted focus and editable titles without mutating the stored object", () => {
    const saved = outline();
    const result = readStoredTeachingOutline(saved, "activity", ["source"]);
    expect(result).toEqual(saved);
    expect(result).not.toBe(saved);
    result!.items[0]!.title = "changed locally";
    expect(saved.items[0]!.title).toBe("实数");
  });
  it.each([
    { ...outline(), activityId: "foreign" },
    { ...outline(), focusItemId: "missing" },
    { ...outline(), items: [{ ...outline().items[0], notes: {} }] },
    { ...outline(), items: [{ ...outline().items[0], sourceIds: ["foreign"] }] },
    { ...outline(), items: [outline().items[0], outline().items[0]] },
  ])("rejects invalid stored data before model dispatch", value => {
    expect(() => readStoredTeachingOutline(value, "activity", ["source"])).toThrow();
  });
  it("rejects source removal rather than silently expanding the evidence scope", () => {
    expect(() => readStoredTeachingOutline(outline(), "activity", [])).toThrow();
  });
});
