import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { BlockRenderer } from "./block-renderer";
import type { ClientInitBlock } from "./component-catalog";

const sourceId = "33333333-3333-4333-8333-333333333333";
function render(content: unknown, blockType = "text", role: ClientInitBlock["role"] = "teach") {
  return renderToStaticMarkup(createElement(BlockRenderer, {
    block: { blockId: "11111111-1111-4111-8111-111111111111", position: 0, blockType, role, content },
    sourceRefs: [{ sourceId, chunkId: "one", version: "2", page: 7 }, { sourceId, chunkId: "other", version: 9, page: 20 },
      { sourceId, chunkId: "unversioned", version: null }, { sourceId, chunkId: "bad-version", version: "latest" }],
  }));
}
it.each(["text", "math", "step", "example"])("shows deduplicated exact citations on %s, never model href or unrelated chunks", type => {
  const html = render({ text: "解释", citedChunkIds: ["one", "one", "missing", "unversioned", "bad-version", null, 3, ""], href: "https://model.example/" }, type);
  expect(html.match(/<a /g)).toHaveLength(1);
  expect(html).toContain(`/opening/library?tab=materials&amp;source=${sourceId}&amp;version=2&amp;page=7`);
  expect(html).toContain("片段 missing · 无法定位");
  expect(html.match(/版本未确认/g)).toHaveLength(2);
  expect(html).not.toContain("version=9");
  expect(html).not.toContain("model.example");
  expect(html).toContain("<details");
  expect(html).not.toContain("<details open");
});
it.each([
  [{ text: "old block" }, "text", "teach"],
  [{ text: "empty", citedChunkIds: [] }, "text", "teach"],
  [{ text: "prompt", citedChunkIds: ["one"] }, "text", "prompt"],
  [{ text: "prompt", citedChunkIds: ["one"] }, "prompt", "teach"],
  [{ text: "secret", citedChunkIds: ["one"] }, "answer_key", "answer_key"],
  [{ text: "unknown", citedChunkIds: ["one"] }, "unknown", "teach"],
  [{ text: "unsafe", citedChunkIds: ["one"], href: "javascript:alert(1)" }, "text", "teach"],
] as const)("omits sources for legacy, empty, private, question and fail-soft blocks %#", (content, type, role) => {
  const html = render(content, type, role);
  expect(html).not.toContain("本段依据");
  expect(html).not.toContain("/opening/library");
  expect(html).not.toContain("secret");
});
it("keeps unmatched strings exact rather than substituting same-source evidence", () => {
  const html = render({ text: "解释", citedChunkIds: [" one"] });
  expect(html).toContain("无法定位");
  expect(html).not.toContain("<a ");
});
