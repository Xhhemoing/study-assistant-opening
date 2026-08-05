import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  RevisionReviewPanel,
  preserveSelectionIds,
  selectableProposalBlockIds,
} from "./revision-review-panel";

describe("revision review panel", () => {
  it("renders an accessible loading state without coupling to manual save", () => {
    const html = renderToStaticMarkup(createElement(RevisionReviewPanel, { documentId: "11111111-1111-4111-8111-111111111111" }));
    expect(html).toContain("正在读取修订提案...");
    expect(html).toContain('aria-label="修订提案"');
  });

  it("limits preserve-both selection to diff entries with proposed blocks", () => {
    expect(selectableProposalBlockIds({
      diff: [
        { blockId: "11111111-1111-4111-8111-111111111111", kind: "removed", base: null, proposed: null },
        { blockId: "22222222-2222-4222-8222-222222222222", kind: "added", base: null, proposed: { id: "22222222-2222-4222-8222-222222222222", type: "paragraph", position: 0, content: { text: "new" } } },
      ],
    })).toEqual(["22222222-2222-4222-8222-222222222222"]);
  });

  it("defaults preserve-both to proposal blocks only until selection is initialized", () => {
    const proposal = {
      diff: [
        { blockId: "11111111-1111-4111-8111-111111111111", kind: "removed" as const, base: null, proposed: null },
        { blockId: "22222222-2222-4222-8222-222222222222", kind: "added" as const, base: null, proposed: { id: "22222222-2222-4222-8222-222222222222", type: "paragraph", position: 0, content: { text: "new" } } },
      ],
    };
    expect(preserveSelectionIds(proposal, [], false)).toEqual(["22222222-2222-4222-8222-222222222222"]);
    expect(preserveSelectionIds(proposal, [], true)).toEqual([]);
  });
});
