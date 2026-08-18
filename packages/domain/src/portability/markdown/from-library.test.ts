import { describe, expect, it } from "vitest";
import { libraryDocumentToPortable } from "./from-library";

const DOC_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B1 = "11111111-1111-4111-8111-111111111111";
const B2 = "22222222-2222-4222-8222-222222222222";
const B3 = "33333333-3333-4333-8333-333333333333";

describe("libraryDocumentToPortable", () => {
  it("maps typed library blocks, tags, and inline links onto the portable IR", () => {
    const document = libraryDocumentToPortable({
      id: DOC_ID,
      title: "导数笔记",
      tags: ["高数"],
      sourceFiles: [{ path: "origin/lecture.md" }],
      blocks: [
        { id: B1, type: "heading", content: { text: "导数", level: 2 } },
        { id: B2, type: "paragraph", content: { text: "参见 [定义](https://example.com/def)。" } },
        { id: B3, type: "codeBlock", content: { text: "const x = 1;", language: "ts" } },
      ],
    });
    expect(document.tags).toEqual(["高数"]);
    expect(document.blocks).toEqual([
      { id: B1, kind: "heading", level: 2, text: "导数" },
      {
        id: B2,
        kind: "paragraph",
        text: "参见 定义。",
        links: [{ label: "定义", href: "https://example.com/def" }],
      },
      { id: B3, kind: "code", language: "ts", text: "const x = 1;" },
    ]);
  });

  it("reads BlockNote-shaped content and reports unknown block types as unsupported", () => {
    const document = libraryDocumentToPortable({
      id: DOC_ID,
      title: "Mixed",
      tags: [],
      blocks: [
        {
          id: B1,
          type: "heading",
          content: {
            blockNoteContent: [{ type: "text", text: "标题" }],
            props: { level: 1 },
            children: [],
          },
        },
        { id: B2, type: "callout", content: { text: "TIP" } },
      ],
    });
    expect(document.blocks[0]).toEqual({ id: B1, kind: "heading", level: 1, text: "标题" });
    expect(document.blocks[1]).toEqual({
      id: B2,
      kind: "unsupported",
      feature: "callout",
      detail: "TIP",
    });
  });
});
