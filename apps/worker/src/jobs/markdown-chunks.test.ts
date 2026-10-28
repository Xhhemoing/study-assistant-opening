import { expect, it } from "vitest";
import { markdownChunks } from "./markdown-chunks";

it("keeps markdown as text and numbers chunks", () => {
  const chunks = markdownChunks("# 标题\n\n<script>alert(1)</script>\n\n正文");
  expect(chunks).toEqual([
    { page: 1, text: "# 标题\n\n<script>alert(1)</script>\n\n正文" },
  ]);
});

it("returns nothing for blank markdown", () => {
  expect(markdownChunks(" \n\n ")).toEqual([]);
});

it("preserves fenced code indentation and every internal blank line", () => {
  const text = "说明\n\n```python\nif ready:\n\n\n    execute()\n```\n\n结束";
  expect(markdownChunks(text)).toEqual([{ page: 1, text }]);
});

it("preserves indented code and content across paragraph-based chunks without hard slicing", () => {
  const text = "    first()\n\n" + "正文".repeat(2200) + "\n\n    second()\n";
  const chunks = markdownChunks(text);
  expect(chunks.map(chunk => chunk.text).join("")).toBe(text);
  expect(chunks.map(chunk => chunk.page)).toEqual(chunks.map((_, index) => index + 1));
  expect(chunks.some(chunk => chunk.text.includes("正文".repeat(2200)))).toBe(true);
  expect(chunks.length).toBeGreaterThan(1);
});
