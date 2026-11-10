import { expect, it } from "vitest";
import type { Sql } from "postgres";
import { chooseSpanRepairTeaching, listSpanTeachingProblems } from "@aistudy/domain";
import { getSpanTeachingProblem } from "@aistudy/domain/span-heldout-catalog";
import { resolveCourseSpanExerciseKeys } from "./opening-course-route-verification-policy";
import { readOpeningSpanPrerequisiteRepair } from "./opening-span-prerequisite-runtime";
const id = "11111111-1111-4111-8111-111111111111", scope = { workspaceId: id, ownerUserId: id };
it("does not borrow generated teaching outside the explicitly confirmed canonical set to manufacture B supply", () => {
  // Real R1 confirmation expansions, not a fabricated executable plan or SQL authority seed.
  for (const confirmed of listSpanTeachingProblems()) {
    let allowed: string[];
    try { allowed = resolveCourseSpanExerciseKeys([confirmed.id]); }
    catch { continue; } // Public confirmation itself refuses families with no validation supply.
    const candidates = allowed.flatMap(key => { const p = getSpanTeachingProblem(key); return p ? [p] : []; });
    expect(chooseSpanRepairTeaching(confirmed, { contentKeys: new Set(), unknownHistory: false }, candidates)).toBeNull();
  }
});
it.each([null, { version: 2 }, { version: 1, status: "ready" }])("typed refuses unsupported saved B %j before any chooser or mutation", async plan => {
  const db = (async () => [{ goal_json: { spanPrerequisiteRepair: plan }, checkpoint_json: {} }]) as unknown as Sql;
  await expect(readOpeningSpanPrerequisiteRepair(db, scope, id)).rejects.toMatchObject({ code: "CONFLICT", reasonCode: "SPAN_PREREQUISITE_PLAN_UNSUPPORTED" });
});
it("keeps ordinary history unmarked rather than backfilling a B plan", async () => {
  const db = (async () => [{ goal_json: {}, checkpoint_json: {} }]) as unknown as Sql;
  expect(await readOpeningSpanPrerequisiteRepair(db, scope, id)).toBeNull();
});
it("cannot reinterpret a return-target binding with missing saved plan as ordinary learning", async () => {
  const db = (async () => [{ goal_json: { spanCourseBinding: { returnTarget: { id } } }, checkpoint_json: {} }]) as unknown as Sql;
  await expect(readOpeningSpanPrerequisiteRepair(db, scope, id)).rejects.toMatchObject({ reasonCode: "SPAN_PREREQUISITE_PLAN_UNSUPPORTED" });
});
it("never swallows real NOWAIT lock errors as an unavailable plan", async () => {
  const error = Object.assign(new Error("could not obtain lock"), { code: "55P03" });
  const db = (async () => { throw error; }) as unknown as Sql;
  await expect(readOpeningSpanPrerequisiteRepair(db, scope, id)).rejects.toBe(error);
});
