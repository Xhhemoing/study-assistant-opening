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
it.each(["Next.js", "未来简史", "2026-10-20 模拟课", "明天的数学"])("does not interpret the course title %s as a query date", title => {
  expect(selectSystemQuery(`《${title}》进度怎么样`, undefined, "2026-10-19"))
    .toMatchObject({ courseText: title, invalidDate: false, dateExplicit: false });
});
it("still parses a date outside the course title", () => {
  expect(selectSystemQuery("《Next.js》明天计划有哪些", undefined, "2026-10-19"))
    .toMatchObject({ courseText: "Next.js", date: "2026-10-20", invalidDate: false });
  expect(selectSystemQuery("《未来简史》下周计划有哪些", undefined, "2026-10-19").invalidDate).toBe(true);
});
it.each(["2026--10-20", "2026-10-20-21", "2026-10-20-", "2026-10-20abc", "2026-"])("rejects the entire malformed date token %s", date => {
  expect(selectSystemQuery(`${date}计划有哪些`, undefined, "2026-10-19").invalidDate).toBe(true);
});
it.each([
  ["2028-02-28", "2028-02-29"], ["2028-02-29", "2028-03-01"],
  ["2026-02-28", "2026-03-01"], ["2026-12-31", "2027-01-01"],
])("resolves tomorrow from %s to %s across calendar boundaries", (today, expected) => {
  expect(selectSystemQuery("明天计划有哪些", undefined, today)).toMatchObject({ date: expected, invalidDate: false });
});
it("does not interpret a temporal English substring in a setting name as a date", () => {
  expect(selectSystemQuery("nextLearningStep设置生效了吗", undefined, "2026-10-19"))
    .toMatchObject({ dateExplicit: false, invalidDate: false, topics: ["settings"] });
});
