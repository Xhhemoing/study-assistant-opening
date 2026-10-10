import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { MaterialAssignPanel } from "./material-assign-panel";

it("renders course and role selectors for single-row assign", () => {
  const html = renderToStaticMarkup(createElement(MaterialAssignPanel, {
    courses: [
      { id: "11111111-1111-4111-8111-111111111111", title: "微积分", archived: false },
      { id: "22222222-2222-4222-8222-222222222222", title: "旧课", archived: true },
    ],
    busy: false,
    onConfirm: async () => {},
    onCancel: () => {},
  }));
  expect(html).toContain("归入课程");
  expect(html).toContain("微积分");
  expect(html).not.toContain("旧课");
  expect(html).toContain("参考资料");
  expect(html).toContain("确认归入");
});
