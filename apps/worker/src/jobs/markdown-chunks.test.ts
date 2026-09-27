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
