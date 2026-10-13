import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LearningProse, PlainTextFallback, proseUrlTransform } from "./learning-prose";
import { MessageList } from "./message-list";

const render = (text: string) => renderToStaticMarkup(createElement(LearningProse, { text }));

describe("LearningProse", () => {
  it("renders lists, tables and code from Markdown", () => {
    const html = render("要点：\n\n- 第一\n- 第二\n\n| 量 | 值 |\n|---|---|\n| a | 1 |\n\n```ts\nconst x = 1;\n```");
    expect(html).toMatch(/<li[^>]*>第一<\/li>/);
    expect(html).toContain("<table");
    expect(html).toContain("<td");
    expect(html).toMatch(/<pre[^>]*overflow-x-auto[^>]*><code class="language-ts">const x = 1;/);
  });

  it("stamps Markdown source offsets on top-level blocks and list items only", () => {
    const text = "段落 **粗** [链](https://e.com)\n\n- a\n- b\n\n| x |\n|---|\n| 1 |\n\n---\n\n$$\nx\n$$";
    const html = render(text);
    const stamped = [...html.matchAll(/<(\w+)[^>]*?data-src-start="(\d+)" data-src-end="(\d+)"/g)]
      .map(([, tag, start, end]) => [tag, text.slice(Number(start), Number(end))]);
    expect(stamped).toEqual([
      ["p", "段落 **粗** [链](https://e.com)"],
      ["ul", "- a\n- b"], ["li", "- a"], ["li", "- b"],
      ["div", "| x |\n|---|\n| 1 |"],
      ["hr", "---"],
      ["div", "$$\nx\n$$"],
    ]);
    expect(html).toContain("katex-display");
    expect(html).not.toMatch(/<(strong|a|code|span|td|th)[^>]*data-src-/);
  });

  it("renders inline and display math with KaTeX", () => {
    const html = render("质能方程 $E=mc^2$。\n\n$$\n\\int_0^1 x\\,dx = \\tfrac12\n$$");
    expect(html).toContain('class="katex"');
    expect(html).toContain("katex-display");
  });

  it("drops raw HTML instead of rendering it", () => {
    const html = render("前<script>alert(1)</script>后 <img src=x onerror=alert(1)>");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
    expect(html).toContain("前");
  });

  it("keeps only http(s) and mailto links", () => {
    expect(proseUrlTransform("https://example.com/a")).toBe("https://example.com/a");
    expect(proseUrlTransform("mailto:a@example.com")).toBe("mailto:a@example.com");
    expect(proseUrlTransform("javascript:alert(1)")).toBe("");
    expect(proseUrlTransform(" JavaScript:alert(1)")).toBe("");
    expect(proseUrlTransform("data:text/html,x")).toBe("");
    expect(proseUrlTransform("/opening/today")).toBe("");

    const html = render("[坏链接](javascript:alert(1)) [好链接](https://example.com)");
    expect(html).not.toContain("javascript:");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("does not load remote images", () => {
    const html = render("![示意图](https://tracker.example/p.png)");
    expect(html).not.toContain("<img");
    expect(html).toContain("[图片：示意图]");
  });

  it("does not execute untrusted KaTeX commands", () => {
    const html = render("$\\href{javascript:alert(1)}{x}$ $\\includegraphics{https://tracker.example/p.png}$");
    // With trust:false the commands render as error text; nothing becomes a link or image.
    expect(html).not.toMatch(/href="javascript:/);
    expect(html).not.toContain("<img");
    expect(html).toContain("#b91c1c");
  });

  it("falls back to the original text when rendering throws", () => {
    expect(PlainTextFallback.getDerivedStateFromError()).toEqual({ failed: true });
    const boundary = new PlainTextFallback({ text: "**原文** <b>", children: null });
    boundary.state = { failed: true };
    const html = renderToStaticMarkup(boundary.render() as never);
    expect(html).toBe('<p class="whitespace-pre-wrap">**原文** &lt;b&gt;</p>');
  });
});

describe("MessageList prose switch", () => {
  const message = { id: "t1", role: "assistant" as const, text: "- 第一\n- 第二", citationLabels: [], citations: [], status: "complete" as const };

  it("renders assistant Markdown when prose is enabled", () => {
    const html = renderToStaticMarkup(createElement(MessageList, { messages: [message], proseEnabled: true }));
    expect(html).toMatch(/<li[^>]*>第一<\/li>/);
  });

  it("keeps plain text when prose is disabled and for user messages", () => {
    const plain = renderToStaticMarkup(createElement(MessageList, { messages: [message], proseEnabled: false }));
    expect(plain).not.toMatch(/<li[^>]*>第一/);
    const user = renderToStaticMarkup(createElement(MessageList, { messages: [{ ...message, role: "user" as const }], proseEnabled: true }));
    expect(user).not.toMatch(/<li[^>]*>第一/);
  });
});
