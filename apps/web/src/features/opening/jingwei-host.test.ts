import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageList } from "./assistant/message-list";
import type { ChatMessageView } from "./assistant/message-model";
import { CLOSED_CAPABILITIES } from "@aistudy/config/public";
import { OpeningCapabilitiesContext } from "./capabilities/capabilities-provider";
import { artifactsForMessages, openingCapabilities } from "./jingwei-host";

function message(id: string, role: "user" | "assistant", text: string, status?: ChatMessageView["status"]): ChatMessageView {
  return { id, role, text, citations: [], citationLabels: [], ...(status ? { status } : {}) };
}

const flowAnswer = "可以这样安排：预习 → 听课 → 做题 → 复盘";

describe("opening jingwei host", () => {
  it("registers standard and teaching capabilities in one catalog", () => {
    expect(openingCapabilities.describe().map((c) => c.id)).toEqual([
      "flow-diagram@1",
      "comparison-bars@1",
      "matrix-transform@1",
    ]);
  });

  it("plans only completed assistant answers and honours the preceding question", () => {
    const result = artifactsForMessages([
      message("u1", "user", "怎么复习？"),
      message("a1", "assistant", flowAnswer),
      message("u2", "user", "一句话说，不要图"),
      message("a2", "assistant", flowAnswer),
      message("u3", "user", "再说一次"),
      message("a3", "assistant", flowAnswer, "pending"),
      message("a4", "assistant", flowAnswer, "failed"),
    ]);
    expect(Object.keys(result)).toEqual(["a1"]);
    expect(result.a1!.artifact.artifactId).toBe("turn-a1");
  });
});

describe("MessageList artifacts", () => {
  const messages = [message("u1", "user", "怎么复习？"), message("a1", "assistant", flowAnswer, "complete")];

  it("renders the 图解 under the answer text when enabled, keeping the text", () => {
    const html = renderToStaticMarkup(createElement(MessageList, { messages, artifactsEnabled: true }));
    expect(html).toContain(flowAnswer);
    expect(html).toContain('data-message-artifact="a1"');
    expect(html).toContain("原文为准");
    expect(html).toContain('data-jingwei-capability="flow-diagram@1"');
    expect(html.indexOf(flowAnswer)).toBeLessThan(html.indexOf("data-message-artifact"));
  });

  it("follows the chatArtifacts capability and fails closed without one", () => {
    const withCaps = (chatArtifacts: boolean) => renderToStaticMarkup(createElement(
      OpeningCapabilitiesContext.Provider,
      { value: { ...CLOSED_CAPABILITIES, chatArtifacts } },
      createElement(MessageList, { messages }),
    ));
    expect(withCaps(true)).toContain('data-message-artifact="a1"');
    expect(withCaps(false)).not.toContain("data-message-artifact");
    expect(renderToStaticMarkup(createElement(MessageList, { messages }))).not.toContain("data-message-artifact");
  });

  it("renders nothing extra when disabled", () => {
    const html = renderToStaticMarkup(createElement(MessageList, { messages, artifactsEnabled: false }));
    expect(html).not.toContain("data-message-artifact");
  });
});
