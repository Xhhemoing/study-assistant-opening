import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Composer, shouldSubmitShortcut } from "./composer";

function markup(practiceMode: boolean) {
  return renderToStaticMarkup(createElement(Composer, {
    practiceMode,
    privacy: "ephemeral",
    onPrivacyChange: () => undefined,
    draft: "Question",
    onDraftChange: () => undefined,
    onSubmit: () => undefined,
  }));
}

describe("practice composer restrictions", () => {
  it("offers only the modes that keep the learning session", () => {
    const html = markup(true);
    expect(html).toContain('value="hint"');
    expect(html).toContain('value="explain"');
    expect(html).not.toContain('value="listen"');
    expect(html).not.toContain('value="think_together"');
  });

  it("renders saved-only privacy with a disabled selector, even if a caller passes ephemeral", () => {
    const html = markup(true);
    const selector = html.match(/<select[^>]*aria-label="隐私模式"[^>]*>.*?<\/select>/)?.[0];
    expect(selector).toBeDefined();
    expect(selector).toContain('disabled=""');
    expect(selector).toContain('value="saved" selected=""');
    expect(selector).not.toContain('value="ephemeral"');
  });

  it("keeps every existing mode and privacy option in the ordinary assistant", () => {
    const html = markup(false);
    for (const mode of ["hint", "explain", "listen", "think_together"]) expect(html).toContain(`value="${mode}"`);
    const selector = html.match(/<select[^>]*aria-label="隐私模式"[^>]*>.*?<\/select>/)?.[0];
    expect(selector).toContain('value="ephemeral" selected=""');
    expect(selector).not.toContain('disabled=""');
  });
});

describe("composer keyboard shortcut", () => {
  it("does not submit Chinese composition or ordinary Enter", () => {
    expect(shouldSubmitShortcut({ key: "Enter", ctrlKey: true, metaKey: false, isComposing: true })).toBe(false);
    expect(shouldSubmitShortcut({ key: "Enter", ctrlKey: false, metaKey: false, isComposing: false })).toBe(false);
  });
  it("submits only a finished Ctrl or Command Enter action", () => {
    expect(shouldSubmitShortcut({ key: "Enter", ctrlKey: true, metaKey: false, isComposing: false })).toBe(true);
    expect(shouldSubmitShortcut({ key: "Enter", ctrlKey: false, metaKey: true, isComposing: false })).toBe(true);
    expect(shouldSubmitShortcut({ key: "a", ctrlKey: true, metaKey: false, isComposing: false })).toBe(false);
  });
});
