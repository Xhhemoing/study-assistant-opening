import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StartSuggestions } from "./start-composer";
import { Composer } from "../assistant/composer";

describe("start composer", () => {
  it("shows examples only when there are no saved suggestions, and limits real suggestions to three", () => {
    const items = [1, 2, 3, 4].map(id => ({ id: String(id), label: `继续 ${id}`, href: `/opening/courses/${id}` }));
    const populated = renderToStaticMarkup(createElement(StartSuggestions, { suggestions: items, examples: ["示例问题"], onExample() {} }));
    expect(populated).toContain("继续 3"); expect(populated).not.toContain("继续 4"); expect(populated).not.toContain("示例问题");
    const empty = renderToStaticMarkup(createElement(StartSuggestions, { suggestions: [], examples: ["示例问题"], onExample() {} }));
    expect(empty).toContain("示例问题");
    for (const href of ["courses", "library/new", "search", "assistant"]) expect(empty).toContain(`href="/opening/${href}"`);
  });
  it("labels removable context and accepts an explicit attachment-only question", () => {
    const html = renderToStaticMarkup(createElement(Composer, { questionMode: true, startMode: true, draft: "", emptyText: "请帮我读题", contextChips: [{ id: "source", label: "题目照片" }], onRemoveContext() {}, onDraftChange() {}, onSubmit() {} }));
    expect(html).toContain('aria-label="不使用 题目照片"');
    expect(html.match(/<button[^>]*aria-label="发送"[^>]*>/)?.[0]).not.toMatch(/\sdisabled=/);
    expect(html).toContain("Shift + Enter 换行");
  });
});
