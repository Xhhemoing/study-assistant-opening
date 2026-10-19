import { describe, expect, it } from "vitest";
import { parseSystemQueryIntent, resolveSystemQueryDate } from "./system-query-intent";
import { createSystemQueryRoute } from "./system-query-routing";
const clock = { today: "2026-12-31", timeZone: "Asia/Shanghai" };
describe("finite query intent and object/date admission", () => {
  it.each([["明天的计划", "2027-01-01"], ["明日安排", "2027-01-01"], ["today plan", "2026-12-31"], ["后天日程", "2027-01-02"], ["昨天的计划", "2026-12-30"], ["2028-02-29 计划", "2028-02-29"]])("resolves %s as one local calendar date", (question, date) => {
    expect(resolveSystemQueryDate(question, clock)).toEqual({ date });
  });
  it.each(["下周的计划", "周一安排", "我有哪些计划", "2026-02-30计划", "2026-1-2计划", "今天和明天的计划"])("asks instead of silently querying today for %s", question => {
    expect(parseSystemQueryIntent(question, clock)).toMatchObject({ blocked: true, clarification: expect.any(String) });
    expect(createSystemQueryRoute(question, clock).fallback()).toEqual([]);
  });
  it.each(["后台任务有哪些", "解析进度怎样", "导入完成了吗", "worker jobs"])("recognizes job synonyms: %s", question => {
    expect(parseSystemQueryIntent(question, clock).kind).toBe("jobs");
  });
  it.each(["我的课程有哪些", "我有哪些课程", "课程列表"])("recognizes course-list phrasing: %s", question => {
    expect(parseSystemQueryIntent(question, clock).kind).toBe("courses");
  });
  it.each(["数学甲学得怎么样", "物理乙的学习情况", "我的学习进展"])("recognizes learning phrasing: %s", question => {
    expect(parseSystemQueryIntent(question, clock).kind).toBe("learning");
  });
  it("treats course names as data and refuses explicit multi-course comparisons", () => {
    expect(parseSystemQueryIntent("“解析几何”的学习进度", clock)).toMatchObject({ kind: "learning", query: "解析几何" });
    expect(parseSystemQueryIntent("比较“数学”和“物理”的学习进度", clock)).toMatchObject({ blocked: true, clarification: expect.stringContaining("多门课程") });
  });
  it.each(["我有哪些任务", "我的待办", "my tasks"])("keeps learning tasks distinct from background jobs: %s", question => {
    expect(createSystemQueryRoute(question, clock).clarification).toContain("后台任务");
  });
  it("refuses an ambiguous source selection and a planner's substituted plan date", () => {
    expect(createSystemQueryRoute("材料在哪页", clock, { sourceIds: ["a", "b"] }).clarification).toContain("多份材料");
    const route = createSystemQueryRoute("明天的计划", clock);
    expect(route.admit({ name: "planning", arguments: { date: "2026-12-31", limit: 5, offset: 0 } })).toBeNull();
    expect(route.clarification).toContain("不一致");
  });
});
