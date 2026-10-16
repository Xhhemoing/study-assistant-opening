import { expect, it } from "vitest";
import type { PlannedBlock } from "@aistudy/contracts";
import { replanDiff } from "./local-replan-card";
const block = (taskId: string, start: string): PlannedBlock => ({ taskId, start, end: `${start}end`, reason: "已确认" });
it("distinguishes a retained historical task block from its new future placement", () => {
  const historical = block("missed", "09:00"), future = block("fixed", "11:00"), added = block("missed", "15:00");
  expect(replanDiff([historical, future], [historical, future, added])).toEqual({ preserved: 2, removed: [], added: [added] });
});
it("lists released closed blocks without presenting unchanged work as moved", () => {
  const old = block("closed", "11:00"), fixed = block("fixed", "14:00"), added = block("new", "11:00");
  expect(replanDiff([old, fixed], [added, fixed])).toEqual({ preserved: 1, removed: [old], added: [added] });
});
