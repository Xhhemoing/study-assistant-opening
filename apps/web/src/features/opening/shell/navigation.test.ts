import { expect, it } from "vitest";
import { openingNavigation } from "./navigation";

it("does not turn the personal assistant into a tools menu", () => {
  expect(openingNavigation().map((item) => item.href)).toEqual([
    "/opening/today",
    "/opening/assistant",
    "/opening/courses",
  ]);
});
