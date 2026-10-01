import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CourseHistory, CourseHistoryPageView } from "./course-history";
import { emptyCourseHistory, type CourseHistoryState } from "./course-history-state";
import { learningObservation } from "../../../../../../packages/domain/src/opening/learning-summary-fixtures";

const handlers = { onMore: () => undefined, onRefresh: () => undefined, onChanged: () => undefined };
const ready: CourseHistoryState = { ...emptyCourseHistory(), status: "ready", snapshotRevision: 7, totalCount: 51,
  observations: [learningObservation], nextCursor: "cursor", snapshotKey: 1 };
describe("course history presentation", () => {
  it("shows fixed revision, loaded/visible totals and manual paging while retaining revision actions", () => {
    const html = renderToStaticMarkup(createElement(CourseHistoryPageView, { ...handlers, state: ready }));
    expect(html).toContain("固定快照版本 7 · 已加载 1 / 51 条当前可见记录");
    expect(html).toContain("新作答与修订请刷新查看");
    expect(html).toContain("继续加载（每页 50 条）");
    expect(html).toContain("刷新历史（新快照）");
    expect(html).toContain("查看历史");
    expect(html).toContain("纠正记录");
    expect(html).toContain("撤回记录");
  });
  it.each(["loading", "error"] as const)("does not render cached bodies during %s", status => {
    const html = renderToStaticMarkup(createElement(CourseHistoryPageView, { ...handlers, state: { ...ready, status, error: "unavailable" } }));
    expect(html).not.toContain(learningObservation.answer);
    expect(html).not.toContain("纠正记录");
  });
  it("distinguishes a true empty page and the last page from a pending read", () => {
    const html = renderToStaticMarkup(createElement(CourseHistoryPageView, { ...handlers, state: { ...ready, observations: [], totalCount: 0, nextCursor: null } }));
    expect(html).toContain("当前筛选下没有可见的历史记录");
    expect(html).not.toContain("继续加载");
    expect(html).not.toContain("正在读取课程历史");
  });
  it("keeps history collapsed and distinguishes the requirement filter modes", () => {
    const html = renderToStaticMarkup(createElement(CourseHistory, { courseId: learningObservation.courseId, requirements: ["", "key / exact"], onChanged: () => undefined }));
    expect(html).not.toContain(" open=");
    expect(html).toContain("全部要求");
    expect(html).toContain("未指定要求");
    expect(html).toContain('value="key:"');
    expect(html).toContain('value="key:key / exact"');
  });
});
