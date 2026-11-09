import { expect, it } from "vitest";
import { chooseOpeningSpanRepairTeaching, parseOpeningSpanRepair, spanRepairAttemptKey } from "./opening-span-repair";
import { getSpanTeachingProblem, spanProblemContentKey } from "@aistudy/domain/span-heldout-catalog";

it("keeps legacy absence distinct from corrupt and unknown-version plans", () => {
  expect(parseOpeningSpanRepair({ tutorNextAction: {} })).toBeNull();
  for (const raw of [null, {}, { version: 2 }, { version: 1, status: "ready" }]) {
    expect(() => parseOpeningSpanRepair({ spanRepair: raw })).toThrowError(expect.objectContaining({ code: "CONFLICT", reasonCode: "SPAN_REPAIR_CHANGED" }));
  }
});
it("chooses distinct canonical teaching content, excludes all issued content and refuses unknown history", () => {
  const source = getSpanTeachingProblem("span-reserved-generated-teaching-consistent-3d-1729-0", "1")!;
  const history = { contentKeys: new Set<string>(), unknownHistory: false };
  const pair = chooseOpeningSpanRepairTeaching(source, history)!;
  expect(pair.teachingExample.id).not.toBe(source.id);
  expect(pair.teachingExample.target).toHaveLength(3);
  expect(spanProblemContentKey(pair.teachingExample)).not.toBe(spanProblemContentKey(pair.practiceVariant));
  history.contentKeys.add(spanProblemContentKey(pair.teachingExample));
  history.contentKeys.add(spanProblemContentKey(pair.practiceVariant));
  const next = chooseOpeningSpanRepairTeaching(source, history)!;
  expect(history.contentKeys.has(spanProblemContentKey(next.teachingExample))).toBe(false);
  expect(chooseOpeningSpanRepairTeaching(source, { ...history, unknownHistory: true })).toBeNull();
  expect(chooseOpeningSpanRepairTeaching({ ...source, familyId: "not-supported" }, history)).toBeNull();
});
it("semantic request identities separate example, variant, confirmation and generic demos", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const keys = ["example", "variant", "confirmation"].map(stage => spanRepairAttemptKey(id, stage as "example" | "variant" | "confirmation"));
  expect(new Set(keys).size).toBe(3);
  expect(keys.every(key => !key.startsWith("span-demo:"))).toBe(true);
});
