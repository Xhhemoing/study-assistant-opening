import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { LiveTaskCard } from "./live-task-card";

it("shows percentages only for byte transfer", () => {
  const upload = renderToStaticMarkup(createElement(LiveTaskCard, { title: "讲义.pdf", phase: "正在上传文件", byteProgress: 37 }));
  expect(upload).toContain('value="37"');
  expect(upload).toContain("37%");
  const parsing = renderToStaticMarkup(createElement(LiveTaskCard, { title: "讲义.pdf", phase: "原件已保存，正在解析" }));
  expect(parsing).toContain("正在解析");
  expect(parsing).not.toContain("%");
  expect(parsing).not.toContain("<progress");
  expect(parsing).not.toContain("识别出");
});
it("keeps a failed task actionable without displaying busy animation", () => {
  const html = renderToStaticMarkup(createElement(LiveTaskCard, { title: "讲义.pdf", phase: "上传失败", failed: true }, createElement("button", null, "重试")));
  expect(html).toContain("上传失败");
  expect(html).toContain("重试");
  expect(html).not.toContain("animate-spin");
  expect(html).not.toContain("animate-shimmer");
});
