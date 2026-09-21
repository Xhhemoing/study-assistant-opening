import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Composer } from "./composer";
import { MessageList } from "./message-list";

describe("opening assistant copy", () => {
  it("describes free conversation in the composer", () => {
    const html = renderToStaticMarkup(createElement(Composer, {
      draft: "",
      onDraftChange: () => undefined,
      onSubmit: () => undefined,
    }));

    expect(html).toContain("自由交流，或基于已选材料提问…");
  });

  it("invites free conversation when no messages exist", () => {
    const html = renderToStaticMarkup(createElement(MessageList, {
      messages: [],
    }));

    expect(html).toContain("自由交流");
    expect(html).not.toContain("指定材料后即可提问");
  });
});

describe("MessageList", () => {
  it("renders outcome_unknown as an explicit no-resubmit warning, not failed", () => {
    const html = renderToStaticMarkup(createElement(MessageList, {
      messages: [{
        id: "turn-1",
        role: "assistant",
        text: "provider timeout",
        citationLabels: [],
        status: "outcome_unknown",
      }],
    }));

    expect(html).toContain(">结果状态未知，请勿重复提交<");
    expect(html).not.toContain("本轮失败");
  });
});
