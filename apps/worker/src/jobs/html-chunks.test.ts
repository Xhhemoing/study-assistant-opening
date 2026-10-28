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

it("preserves preformatted code indentation and blank lines alongside normal paragraphs", () => {
  const code = "if a:\n    if b:\n\n        print(1)\n    print(2)";
  const html = `<p>开始  说明</p><pre><code>${code}</code></pre><style>.hidden { color: red; }</style><script>alert(1)</script><p>结束  说明</p>`;
  expect(htmlText(html)).toBe(`开始 说明\n${code}\n结束 说明`);
  expect(htmlChunks(html)).toEqual([{ page: 1, text: `开始 说明\n${code}\n结束 说明` }]);
});

it("keeps leading indentation and literal placeholder-like text inside a pre block", () => {
  const code = "    print('&lt;pre&gt; __PRE_0__')\n\n\tprint(2)";
  expect(htmlText(`<pre>${code}</pre>`)).toBe("    print('<pre> __PRE_0__')\n\n\tprint(2)");
});
