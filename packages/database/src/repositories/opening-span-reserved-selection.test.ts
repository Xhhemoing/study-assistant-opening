import { expect, it } from "vitest";
import { listSpanReservedProblems } from "@aistudy/domain/span-heldout-catalog";
import { chooseOpeningSpanReservedProblem } from "./opening-span-reserved-selection";
const empty = () => ({ problemIds: new Set<string>(), familyIds: new Set<string>(), contentKeys: new Set<string>(), unknownHistory: false });
it("prefers unseen families but supplies unseen content after every fixed item was displayed", () => {
  expect(chooseOpeningSpanReservedProblem(empty(), "self_study")).toMatchObject({ kind: "available", problem: { id: "span-reserved-fraction" } });
  const seen = empty(); seen.familyIds.add("span:rational-3d");
  expect(chooseOpeningSpanReservedProblem(seen, "self_study")).toMatchObject({ kind: "available", problem: { id: "span-reserved-dependent" } });
  const fixed = listSpanReservedProblems();
  const exhausted = { ...empty(), problemIds: new Set(fixed.map(p => p.id)), familyIds: new Set(fixed.map(p => p.familyId)) };
  expect(chooseOpeningSpanReservedProblem(exhausted, "self_study")).toMatchObject({ kind: "available", problem: { familyId: "span:rational-3d" } });
});
it("does not advertise a check when history is unknown or the actual content pool is exhausted", () => {
  expect(chooseOpeningSpanReservedProblem({ ...empty(), unknownHistory: true }, "self_study")).toEqual({ kind: "unavailable", reason: "unknown_history" });
  const seen = empty();
  for (let i = 0; i < 100; i++) {
    const choice = chooseOpeningSpanReservedProblem(seen, "self_study");
    if (choice.kind === "unavailable") { expect(choice.reason).toBe("exhausted"); expect(i).toBeGreaterThanOrEqual(12); return; }
    expect(seen.problemIds.has(choice.problem.id)).toBe(false);
    seen.problemIds.add(choice.problem.id); seen.familyIds.add(choice.problem.familyId);
  }
  throw new Error("bounded content pool did not exhaust");
});
