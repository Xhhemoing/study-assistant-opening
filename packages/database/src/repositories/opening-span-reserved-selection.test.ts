import { expect, it } from "vitest";
import { listSpanReservedProblems } from "@aistudy/domain/span-heldout-catalog";
import { chooseOpeningSpanReservedProblem } from "./opening-span-reserved-selection";
const empty = () => ({ problemIds: new Set<string>(), familyIds: new Set<string>(), unknownHistory: false });
it("selects only an unexposed item and family using the same issue policy", () => {
  expect(chooseOpeningSpanReservedProblem(empty(), "self_study")).toMatchObject({ kind: "available", problem: { id: "span-reserved-fraction" } });
  const seen = empty(); seen.familyIds.add("span:rational-3d");
  expect(chooseOpeningSpanReservedProblem(seen, "self_study")).toMatchObject({ kind: "available", problem: { id: "span-reserved-dependent" } });
});
it("does not advertise a new executable check when history is unknown or all families were used", () => {
  expect(chooseOpeningSpanReservedProblem({ ...empty(), unknownHistory: true }, "self_study")).toEqual({ kind: "unavailable", reason: "unknown_history" });
  expect(chooseOpeningSpanReservedProblem({ ...empty(), familyIds: new Set(listSpanReservedProblems().map(row => row.familyId)) }, "self_study"))
    .toEqual({ kind: "unavailable", reason: "exhausted" });
});
