import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LearningProse } from "./learning-prose";
import { selectedSourceFor, type SourceNode } from "./selection-source";

const TEXT = "## 结论\n\n先看定义。\n\n- 第一项\n- 第二项\n- 第三项\n\n$$\nE=mc^2\n$$";

/** Plain-object stand-in for the rendered tree: root > block (data-src-*) > text. */
function node(parentNode: SourceNode | null, attrs: Record<string, string> = {}): SourceNode {
  return { parentNode, getAttribute: (name) => attrs[name] ?? null };
}
/** Offsets exactly as LearningProse stamps them, read from the server render. */
function offsets(text: string) {
  return [...renderToStaticMarkup(createElement(LearningProse, { text })).matchAll(/<(\w+)[^>]*?data-src-start="(\d+)" data-src-end="(\d+)"/g)]
    .map(([, tag, start, end]) => ({ tag: tag!, start: start!, end: end! }));
}
function blockText(root: SourceNode, block: { start: string; end: string }) {
  return node(node(root, { "data-src-start": block.start, "data-src-end": block.end }));
}

describe("selectedSourceFor", () => {
  const root = node(null);
  const blocks = offsets(TEXT);
  const [heading, paragraph, , item1, , item3, math] = blocks;

  it("widens a selection across blocks to their full Markdown source", () => {
    expect(blocks.map((block) => block.tag)).toEqual(["h3", "p", "ul", "li", "li", "li", "div"]);
    const result = selectedSourceFor(TEXT, root, { anchorNode: blockText(root, paragraph!), focusNode: blockText(root, heading!) });
    expect(result).toEqual({ kind: "source", text: "## 结论\n\n先看定义。" });
    expect(selectedSourceFor(TEXT, root, { anchorNode: blockText(root, item3!), focusNode: blockText(root, math!) }))
      .toEqual({ kind: "source", text: "- 第三项\n\n$$\nE=mc^2\n$$" });
  });

  it("maps a selection inside one block, using the nearest list item rather than the whole list", () => {
    const text = blockText(root, item1!);
    expect(selectedSourceFor(TEXT, root, { anchorNode: text, focusNode: text })).toEqual({ kind: "source", text: "- 第一项" });
  });

  it("falls back when an end has no mapped ancestor below the root or the offsets are invalid", () => {
    const unmapped = node(node(root));
    expect(selectedSourceFor(TEXT, root, { anchorNode: blockText(root, paragraph!), focusNode: unmapped })).toEqual({ kind: "fallback" });
    expect(selectedSourceFor(TEXT, root, { anchorNode: null, focusNode: null })).toEqual({ kind: "fallback" });
    // A marked block above the message root (e.g. another message) must not be used.
    const innerRoot = node(node(null, { "data-src-start": "0", "data-src-end": "4" }));
    const inside = node(innerRoot);
    expect(selectedSourceFor(TEXT, innerRoot, { anchorNode: inside, focusNode: inside })).toEqual({ kind: "fallback" });
    const broken = blockText(root, { start: "5", end: String(TEXT.length + 1) });
    expect(selectedSourceFor(TEXT, root, { anchorNode: broken, focusNode: broken })).toEqual({ kind: "fallback" });
  });
});
