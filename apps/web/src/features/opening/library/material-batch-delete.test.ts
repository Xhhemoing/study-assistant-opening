import { describe, expect, it, vi } from "vitest";
import { deleteSelectedMaterials } from "./material-batch-delete";
import { SourceActionsError } from "../inbox/source-actions-client";

describe("deleteSelectedMaterials", () => {
  it("deletes sequentially via impact+act and reports succeeded/failed counts", async () => {
    const impact = vi.fn(async (id: string) => ({
      sourceId: id,
      version: 1,
      aiExcluded: false,
      courses: id === "ok" ? [{ membershipId: "m1", title: "课", archivedAt: null }] : [],
    }));
    const act = vi.fn(async (id: string) => {
      if (id === "bad") throw new SourceActionsError(409, "材料或课程引用已变化，请重新查看影响后确认。");
      return { deleted: true, cleanupPending: 0 };
    });
    const result = await deleteSelectedMaterials(["ok", "bad", "ok"], { impact, act, deletions: vi.fn() } as never);
    expect(impact).toHaveBeenCalledTimes(2);
    expect(act).toHaveBeenCalledTimes(2);
    expect(result.succeeded).toEqual(["ok"]);
    expect(result.failed).toEqual([{ id: "bad", message: "材料或课程引用已变化，请重新查看影响后确认。" }]);
  });
});
