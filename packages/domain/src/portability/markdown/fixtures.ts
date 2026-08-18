import type { PortableDocument } from "./types";

export const DOC_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const H_ID = "11111111-1111-4111-8111-111111111111";
export const P_ID = "22222222-2222-4222-8222-222222222222";
export const L_ID = "33333333-3333-4333-8333-333333333333";
export const C_ID = "44444444-4444-4444-8444-444444444444";
export const M_ID = "55555555-5555-4555-8555-555555555555";
export const T_ID = "66666666-6666-4666-8666-666666666666";
export const A_ID = "77777777-7777-4777-8777-777777777777";
export const U_ID = "88888888-8888-4888-8888-888888888888";

export function sampleDocument(
  overrides: Partial<PortableDocument> = {},
): PortableDocument {
  return {
    id: DOC_ID,
    title: "导数笔记",
    tags: ["高数", "极限"],
    sourceFiles: [{ path: "origin/lecture.md", mediaType: "text/markdown" }],
    blocks: [
      { id: H_ID, kind: "heading", level: 1, text: "导数" },
      {
        id: P_ID,
        kind: "paragraph",
        text: "参见 定义。",
        links: [{ label: "定义", href: "https://example.com/def" }],
      },
      { id: L_ID, kind: "list-item", ordered: false, text: "先求极限" },
      { id: C_ID, kind: "code", language: "ts", text: "const dy = f(x);" },
      { id: M_ID, kind: "math", text: "E = mc^2" },
      {
        id: T_ID,
        kind: "table",
        headers: ["项", "值"],
        rows: [["斜率", "极限"]],
      },
      {
        id: A_ID,
        kind: "attachment",
        filename: "graph.png",
        href: "attachments/graph.png",
        alt: "图像",
      },
    ],
    ...overrides,
  };
}
