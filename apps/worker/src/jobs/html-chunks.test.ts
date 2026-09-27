import { expect, it } from "vitest";
import { htmlChunks, htmlText } from "./html-chunks";

it("drops scripts and tags before keeping visible text", () => {
  const text = htmlText("<h1>标题</h1><script>alert(1)</script><p>正文 &amp; 说明</p>");
  expect(text).toContain("标题");
  expect(text).toContain("正文 & 说明");
  expect(text).not.toContain("alert");
  expect(text).not.toContain("<script>");
});

it("returns numbered chunks and nothing for empty markup", () => {
  expect(htmlChunks("<script>alert(1)</script>")).toEqual([]);
  expect(htmlChunks("<p>第一段</p>")).toEqual([{ page: 1, text: "第一段" }]);
});
