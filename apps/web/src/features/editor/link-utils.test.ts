import { describe, expect, it } from "vitest";
import { extractWikiLinks } from "./link-utils";

describe("wiki link extraction", () => {
  it("extracts unique links from text, inline content, and nested blocks", () => {
    const blocks = [
      {
        id: "one",
        type: "paragraph",
        content: [{ type: "text", text: "参考 [[线性代数]] 和 [[微积分]]。" }],
        children: [{ id: "child", type: "paragraph", content: "再次提到 [[线性代数]]" }],
      },
    ];

    expect(extractWikiLinks(blocks)).toEqual(["线性代数", "微积分"]);
  });

  it("ignores empty wiki links and unrelated content", () => {
    expect(extractWikiLinks([
      { id: "one", type: "paragraph", content: "[] [[]] 普通文本" },
    ])).toEqual([]);
  });
});
