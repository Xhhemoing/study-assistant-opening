import { describe, expect, it } from "vitest";
import { markdownToNoteBlocks } from "./markdown-blocks";

describe("markdownToNoteBlocks", () => {
  it("keeps headings, lists, code, math and tables as blocks", () => {
    const { blocks, structured } = markdownToNoteBlocks([
      "## 结论",
      "",
      "先看 **定义** 和 $x^2$。",
      "",
      "1. 第一步",
      "   - 细节",
      "2. 第二步",
      "",
      "- [x] 已懂",
      "",
      "```ts",
      "const a = 1;",
      "```",
      "",
      "$$",
      "E=mc^2",
      "$$",
      "",
      "| 量 | 值 |",
      "|---|---|",
      "| a | 1 |",
      "",
      "---",
    ].join("\n"));
    expect(structured).toBe(true);
    expect(blocks.map((block) => block.type)).toEqual([
      "heading", "paragraph", "numberedListItem", "numberedListItem", "checkListItem", "codeBlock", "codeBlock", "table", "divider",
    ]);
    expect(blocks[0]).toMatchObject({ props: { level: 2 }, content: [{ type: "text", text: "结论", styles: {} }] });
    expect(blocks[1]!.content).toEqual([
      { type: "text", text: "先看 ", styles: {} },
      { type: "text", text: "定义", styles: { bold: true } },
      { type: "text", text: " 和 $x^2$。", styles: {} },
    ]);
    expect(blocks[2]!.children).toMatchObject([{ type: "bulletListItem", content: [{ text: "细节" }] }]);
    expect(blocks[4]).toMatchObject({ props: { checked: true } });
    expect(blocks[5]).toMatchObject({ props: { language: "ts" }, content: "const a = 1;" });
    expect(blocks[6]).toMatchObject({ props: { language: "latex" }, content: "E=mc^2" });
    expect(blocks[7]!.content).toMatchObject({
      type: "tableContent",
      headerRows: 1,
      rows: [{ cells: [[{ text: "量" }], [{ text: "值" }]] }, { cells: [[{ text: "a" }], [{ text: "1" }]] }],
    });
  });

  it("drops raw HTML, remote images and unsafe links like the chat renderer", () => {
    const { blocks } = markdownToNoteBlocks('<script>alert(1)</script>\n\n![图](https://evil.test/x.png) [点我](javascript:alert(1)) [文档](https://example.com)');
    expect(blocks).toHaveLength(1);
    expect(JSON.stringify(blocks)).not.toMatch(/script|evil\.test|javascript:/);
    expect(blocks[0]!.content).toEqual([
      { type: "text", text: "[图片：图] 点我 ", styles: {} },
      { type: "link", href: "https://example.com", content: [{ type: "text", text: "文档", styles: {} }] },
    ]);
  });

  it("flattens a quote into one inline block", () => {
    const { blocks } = markdownToNoteBlocks("> 第一行\n>\n> 第二行");
    expect(blocks).toEqual([{ type: "quote", props: null, children: [], content: [
      { type: "text", text: "第一行\n第二行", styles: {} },
    ] }]);
  });

  it("falls back to one plain paragraph when parsing fails or yields nothing", () => {
    const deep = `${">".repeat(20_000)} x`;
    expect(markdownToNoteBlocks(deep)).toEqual({ structured: false, blocks: [{ type: "paragraph", props: null, content: deep, children: [] }] });
    expect(markdownToNoteBlocks("<div>only html</div>")).toMatchObject({ structured: false, blocks: [{ content: "<div>only html</div>" }] });
  });
});
