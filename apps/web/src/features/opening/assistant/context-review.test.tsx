import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ContextReview, type ContextReviewProps } from "./context-review";

const id = "11111111-1111-4111-8111-111111111111";
const defaults: ContextReviewProps = {
  courseBound: false, attemptBound: false, selectedSourceCount: 0,
  materialMode: "auto", privacy: "saved", returnHref: null,
};
const render = (props: Partial<ContextReviewProps> = {}) => renderToStaticMarkup(<ContextReview {...defaults} {...props} />);

describe("context review (SSR presentation, no send or identity mutation)", () => {
  it("shows the ordinary unbound scope without inventing a course or reference", () => {
    const html = render();
    expect(html).toContain("未绑定课程 · 普通对话");
    expect(html).toContain("未绑定课程，不会自动补入课程资料");
    expect(html).toContain("已选资料：0 份");
    expect(html).not.toContain("用户携入片段");
    expect(html).not.toContain("题目绑定");
    expect(html).not.toContain("<button");
  });

  it("renders restored identity labels, zero-valued versions and full expandable carried text", () => {
    const fragment = `开头\n${"完整背景".repeat(180)}\n末尾 <不是引用>`;
    const html = render({ courseBound: true, courseLabel: "高等数学", taskLabel: "练习导数",
      studyContext: { courseId: id, activityId: id, label: "导数学习单元", contentVersion: 0,
        sourceId: id, sourceVersion: 0, page: 12, fragment },
      returnHref: "/opening/library?tab=materials", selectedSourceCount: 2, materialMode: "selected" });
    expect(html).toContain("课程：高等数学");
    expect(html).toContain("任务：练习导数");
    expect(html).toContain("第 12 页");
    expect(html).toContain("学习内容版本：0");
    expect(html).toContain("材料版本：0");
    expect(html).toContain("<details>");
    expect(html).toContain("展开完整片段");
    expect(html).toContain("完整背景".repeat(180));
    expect(html).toContain("末尾 &lt;不是引用&gt;");
    expect(html).toContain("并非已核对的引文");
    expect(html).toContain('href="/opening/library?tab=materials"');
    expect(html).not.toContain(id);
    expect(html).not.toContain("<button");
  });

  it.each([
    [{ activityId: id }, "背景将在你发送时作为文字附上"],
    [{ sourceId: id }, "已指定参考材料和位置"],
    [{ courseId: id }, "导航不会自动更换这段对话的课程"],
  ])("preserves existing background meaning for %j", (studyContext, expected) => {
    expect(render({ studyContext, courseBound: true })).toContain(expected);
  });

  it("keeps no-materials separate from saved history and carried text", () => {
    const html = render({ materialMode: "none", selectedSourceCount: 3, studyContext: { fragment: "保留的携入文字" } });
    expect(html).toContain("已选资料：3 份 · 不用资料");
    expect(html).toContain("不用资料不等于清空历史或携入文字");
    expect(html).toContain("资料选择不会清除已保存历史");
    expect(html).toContain("保留的携入文字");
  });

  it("does not claim saved-history continuity in a temporary conversation", () => {
    const html = render({ privacy: "ephemeral", materialMode: "none" });
    expect(html).toContain("临时对话不接续已保存历史");
    expect(html).toContain("刷新后不会恢复");
    expect(html).not.toContain("资料选择不会清除已保存历史");
  });

  it.each([true, false])("keeps attempt binding for learningAttempt=%s without identity removal controls", attemptBound => {
    const html = render({ attemptBound, studyContext: attemptBound ? undefined : { attemptId: id, itemVersionId: id } });
    expect(html).toContain("题目绑定");
    expect(html).toContain("资料选择不会解除题目绑定");
    expect(html).not.toContain(id);
    expect(html).not.toContain("<button");
  });

  it("exposes opaque identity only under the existing diagnostics toggle and hides embedded return links", () => {
    const props = { studyContext: { courseId: id, attemptId: id, sourceId: id }, returnHref: "/opening/today" };
    expect(render(props)).not.toContain(id);
    const html = render({ ...props, embedded: true, diagnostics: true });
    expect(html).toContain('aria-label="提问背景诊断"');
    expect(html).toContain(id);
    expect(html).not.toContain('href="/opening/today"');
  });

  it("distinguishes automatic retrieval and selected-but-empty input from actual citations", () => {
    expect(render({ courseBound: true })).toContain("已选数量不代表实际检索或引用数量");
    const html = render({ materialMode: "selected" });
    expect(html).toContain("尚未选择时不能发送");
    expect(html).toContain("实际资料引用仍在各条回答中查看和核对");
  });
});
