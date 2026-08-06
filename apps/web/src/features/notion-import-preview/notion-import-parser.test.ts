import { describe, expect, it } from "vitest";

import {
  indexNotionZip,
  parseNotionPageHtml,
  type ImportedPage,
} from "./notion-import-parser";

const samplePageHtml = `
<!DOCTYPE html>
<html><head><title>贝叶斯公式</title></head><body>
<article class="page">
<table>
  <tr><td>状态</td><td>进行中</td></tr>
  <tr><td>标签</td><td>概率论</td></tr>
</table>
<div class="page-body">
  <div class="notion-text-block"><p>这是正文第一段。</p></div>
  <div class="notion-heading-block"><h2>从先验到后验</h2></div>
  <div class="notion-text-block"><p>先验是起点，<a href="https://www.notion.so/Diagnostic-Example-9b2f4c1d8e7a4f6b9c3d5e7f8a9b0c1d">诊断测试的例子</a>更新信念。</p></div>
  <div class="notion-bulleted-list-block"><ul><li>第一项</li><li>第二项</li></ul></div>
  <div class="notion-numbered-list-block"><ol><li>先做 A</li><li>再做 B</li></ol></div>
  <div class="notion-to-do-block"><div><input type="checkbox" />读完第 3 章</div></div>
  <div class="notion-toggle-block"><details><summary>折叠标题</summary><div class="notion-text-block"><p>折叠内容。</p></div></details></div>
  <div class="notion-callout-block"><blockquote class="notion-callout"><p>💡 记一个要点</p></blockquote></div>
  <div class="notion-code-block"><pre><code>const p = 0.01;</code></pre></div>
  <div class="notion-image-block"><figure><img src="Bayes-7f3a9c2e.png" /></figure></div>
  <div class="notion-table-block"><table><tr><td>方法</td><td>准确率</td></tr><tr><td>规则</td><td>0.85</td></tr></table></div>
  <div class="notion-divider-block"><hr /></div>
</div>
</article>
</body></html>`;

describe("notion html page parser", () => {
  it("extracts blocks, properties, attachments and rewrites internal links", () => {
    const page = parseNotionPageHtml(samplePageHtml, "贝叶斯公式 4f5e6d7c8b9a0f1e2d3c4b5a69788776.html");

    expect(page.id).toBe("4f5e6d7c8b9a0f1e2d3c4b5a69788776");
    expect(page.title).toBe("贝叶斯公式");
    expect(page.properties).toEqual([
      { name: "状态", type: "text", value: "进行中" },
      { name: "标签", type: "text", value: "概率论" },
    ]);

    const types = page.blocks.map((block) => block.type);
    expect(types).toEqual([
      "paragraph",
      "heading",
      "paragraph",
      "bulleted-list",
      "numbered-list",
      "to-do",
      "toggle",
      "callout",
      "code",
      "image",
      "table",
      "divider",
    ]);

    const heading = page.blocks[1];
    expect(heading.level).toBe(2);
    expect(heading.text).toBe("从先验到后验");

    const linkParagraph = page.blocks[2];
    expect(linkParagraph.links?.[0]).toMatchObject({
      pageId: "9b2f4c1d8e7a4f6b9c3d5e7f8a9b0c1d",
      label: "诊断测试的例子",
    });

    const todo = page.blocks[5];
    expect(todo.checked).toBe(false);

    const toggle = page.blocks[6];
    expect(toggle.text).toBe("折叠标题");
    expect(toggle.losses).toContain("toggle-flattened");
    expect(toggle.children?.[0].type).toBe("paragraph");

    const callout = page.blocks[7];
    expect(callout.text).toContain("💡");
    expect(callout.losses).toContain("callout-style");

    const image = page.blocks[9];
    expect(image.src).toBe("Bayes-7f3a9c2e.png");

    const table = page.blocks[10];
    expect(table.rows).toEqual([
      ["方法", "准确率"],
      ["规则", "0.85"],
    ]);
  });

  it("falls back to plain paragraph when html has no notion classes", () => {
    const page = parseNotionPageHtml(
      '<div class="page-body"><div><p>无 class 的块</p></div></div>',
      "plain-1234567890abcdef1234567890abcdef.html",
    );
    expect(page.blocks).toEqual([{ type: "paragraph", text: "无 class 的块" }]);
  });

  it("keeps columns as a column block with children", () => {
    const page = parseNotionPageHtml(
      `<div class="page-body">
        <div class="notion-column-list-block">
          <div class="notion-column-block">
            <div class="notion-text-block"><p>左列</p></div>
          </div>
          <div class="notion-column-block">
            <div class="notion-text-block"><p>右列</p></div>
          </div>
        </div>
      </div>`,
      "columns-1234567890abcdef1234567890abcdef.html",
    );
    expect(page.blocks[0].type).toBe("columns");
    expect(page.blocks[0].columns?.[0][0].text).toBe("左列");
    expect(page.blocks[0].columns?.[1][0].text).toBe("右列");
  });
});

describe("notion zip index", () => {
  it("indexes pages, skips index.html and csv, and collects attachments", () => {
    const entries = [
      { path: "index.html", content: "<html><body>summary</body></html>" },
      { path: "贝叶斯公式 4f5e6d7c8b9a0f1e2d3c4b5a69788776.html", content: samplePageHtml },
      { path: "数据库 1234567890abcdef1234567890abcdef.csv", content: "a,b" },
      { path: "Bayes-7f3a9c2e.png", content: new Uint8Array([1, 2, 3]) },
    ];

    const result = indexNotionZip(entries);

    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].id).toBe("4f5e6d7c8b9a0f1e2d3c4b5a69788776");
    expect(result.attachments.map((attachment) => attachment.path)).toEqual(["Bayes-7f3a9c2e.png"]);
    expect(result.report.pages).toBe(1);
    expect(result.report.blocks).toBe(12);
    expect(result.report.attachments).toBe(1);
    expect(result.report.losses).toEqual(
      expect.arrayContaining([
        { kind: "toggle-flattened", count: 1 },
        { kind: "callout-style", count: 1 },
      ]),
    );
  });

  it("produces a per-page report entry", () => {
    const result = indexNotionZip([
      { path: "贝叶斯公式 4f5e6d7c8b9a0f1e2d3c4b5a69788776.html", content: samplePageHtml },
    ]);
    expect(result.report.pageReports[0]).toMatchObject({
      title: "贝叶斯公式",
      blockCount: 12,
      lossKinds: ["toggle-flattened", "callout-style"],
    });
  });
});

export type { ImportedPage };
