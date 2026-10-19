import { expect, it } from "vitest";
import { previousRecordQuestion } from "@aistudy/contracts";
import { selectSystemQuery } from "./system-query-focus";

it("does not split a user's compound question into separate history turns", () => {
  const prior = previousRecordQuestion([{ role: "user", text: "高数进度怎么样；当前任务有哪些" }]);
  expect(selectSystemQuery("刷新", prior, "2026-10-19")).toMatchObject({
    courseText: "高数", topics: ["learner_state", "planning"], date: "2026-10-19",
  });
});
it("resolves 那么 followed by an arbitrary course without swallowing 么", () => {
  expect(selectSystemQuery("那么离散数学呢", "高数进度怎么样", "2026-10-19").courseText).toBe("离散数学");
});
