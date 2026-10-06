import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Composer, logicalSendFingerprint, nextClientKey, shouldSubmitShortcut } from "./composer";

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

describe("composer logical-send idempotency", () => {
  it("reuses the same client key for an unchanged unconfirmed retry and mints on content drift", () => {
    const fingerprint = logicalSendFingerprint({
      text: "  explain this  ", mode: "explain", sourceIds: ["b", "a"], currentPage: 2,
    });
    const first = nextClientKey({ clientKey: null, fingerprint: null, nextFingerprint: fingerprint });
    const retry = nextClientKey({ clientKey: first.clientKey, fingerprint: first.fingerprint, nextFingerprint: fingerprint });
    expect(retry).toEqual(first);

    const changed = nextClientKey({
      clientKey: first.clientKey, fingerprint: first.fingerprint,
      nextFingerprint: logicalSendFingerprint({ text: "different", mode: "explain", sourceIds: ["a", "b"], currentPage: 2 }),
    });
    expect(changed.clientKey).not.toBe(first.clientKey);
    expect(changed.fingerprint).not.toBe(first.fingerprint);
  });
});
