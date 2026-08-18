import { describe, expect, it } from "vitest";
import { exportMarkdown } from "./export";
import { importMarkdown } from "./import";
import { A_ID, C_ID, H_ID, L_ID, M_ID, P_ID, T_ID, U_ID, sampleDocument } from "./fixtures";

describe("markdown round-trip", () => {
  it("preserves headings, lists, code, math, tables, attachments, links, tags, and block ids", () => {
    const original = sampleDocument();
    const exported = exportMarkdown(original);
    const imported = importMarkdown(exported.markdown);

    expect(exported.lossReport.claimedLossless).toBe(false);
    expect(imported.lossReport.claimedLossless).toBe(false);
    expect(imported.document.id).toBe(original.id);
    expect(imported.document.title).toBe(original.title);
    expect(imported.document.tags).toEqual(original.tags);
    expect(imported.document.sourceFiles).toEqual(original.sourceFiles);
    expect(imported.document.blocks).toEqual(original.blocks);
    expect(exported.manifest.blockIdentities.map((item) => item.blockId)).toEqual(
      original.blocks.map((block) => block.id),
    );
    expect(exported.manifest.attachments).toEqual([
      {
        id: A_ID,
        filename: "graph.png",
        mediaType: "application/octet-stream",
        href: "attachments/graph.png",
      },
    ]);
    expect(exported.markdown).toContain(`<!-- aistudy-block:${H_ID} -->`);
    expect(exported.markdown).toContain("# 导数");
    expect(exported.markdown).toContain("[定义](https://example.com/def)");
    expect(exported.markdown).toContain("- 先求极限");
    expect(exported.markdown).toContain("```ts");
    expect(exported.markdown).toContain("$$");
    expect(exported.markdown).toContain("| 项 | 值 |");
    expect(exported.markdown).toContain(`![图像](attachments/graph.png)`);
    expect(imported.identityMap.find((item) => item.blockId === P_ID)?.marker).toBe(
      `aistudy-block:${P_ID}`,
    );
    expect(imported.identityMap.map((item) => item.blockId)).toEqual(
      [H_ID, P_ID, L_ID, C_ID, M_ID, T_ID, A_ID],
    );
  });

  it("records unsupported features in a structured loss report and still does not claim lossless", () => {
    const original = sampleDocument({
      blocks: [
        { id: U_ID, kind: "unsupported", feature: "callout", detail: "TIP: remember" },
      ],
    });
    const exported = exportMarkdown(original);
    expect(exported.lossReport.claimedLossless).toBe(false);
    expect(exported.lossReport.losses).toEqual([
      {
        code: "unsupported-block",
        feature: "callout",
        message: "Callout blocks are not expressible in Markdown.",
        blockId: U_ID,
        documentId: original.id,
      },
    ]);
    expect(exported.markdown).toContain(`<!-- aistudy-unsupported:callout -->`);

    const imported = importMarkdown(exported.markdown);
    expect(imported.lossReport.claimedLossless).toBe(false);
    expect(imported.document.blocks).toEqual([
      { id: U_ID, kind: "unsupported", feature: "callout", detail: "" },
    ]);
    expect(imported.lossReport.losses.some((loss) => loss.feature === "callout")).toBe(true);
  });

  it("reports wiki transclusion syntax as an unsupported markdown feature", () => {
    const imported = importMarkdown(`---
id: ${sampleDocument().id}
title: Wiki
tags: []
---

<!-- aistudy-block:${P_ID} -->
See ![[other-note]] for context.
`);
    expect(imported.lossReport.claimedLossless).toBe(false);
    expect(imported.lossReport.losses.some((loss) => loss.code === "wiki-transclusion")).toBe(
      true,
    );
  });
});
