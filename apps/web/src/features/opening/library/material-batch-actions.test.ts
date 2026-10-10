import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MaterialBatchActions } from "./material-batch-actions";

describe("MaterialBatchActions", () => {
  it("shows bulk delete control when onDelete is provided", () => {
    const html = renderToStaticMarkup(createElement(MaterialBatchActions, {
      count: 2,
      courses: [{ id: "11111111-1111-4111-8111-111111111111", title: "微积分", archived: false }],
      busy: false,
      courseId: null,
      onAdd: async () => {},
      onRemove: async () => {},
      onDelete: async () => {},
      onClear: () => {},
    }));
    expect(html).toContain("删除材料");
    expect(html).toContain("已选择 2 份");
    expect(html).toContain("归入课程");
  });

  it("omits bulk delete when onDelete is absent", () => {
    const html = renderToStaticMarkup(createElement(MaterialBatchActions, {
      count: 1,
      courses: [],
      busy: false,
      courseId: null,
      onAdd: async () => {},
      onRemove: async () => {},
      onClear: () => {},
    }));
    expect(html).not.toContain("删除材料");
  });
});
