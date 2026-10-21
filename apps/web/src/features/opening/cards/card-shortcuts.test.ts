import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { resolveCardShortcut } from "./card-shortcuts";
import { CardStack } from "./card-stack";

describe("card review shortcuts", () => {
  const ready = { flipped: true, disabled: false };
  it("flips with space and enables the four grades only after reveal", () => {
    expect(resolveCardShortcut({ key: " " }, { ...ready, flipped: false })).toEqual({ kind: "flip" });
    for (const [key, grade] of [["1", "again"], ["2", "hard"], ["3", "good"], ["4", "easy"]]) {
      expect(resolveCardShortcut({ key: key! }, ready)).toEqual({ kind: "grade", grade });
      expect(resolveCardShortcut({ key: key! }, { ...ready, flipped: false })).toBeNull();
    }
  });
  it("ignores composition, held keys, shortcuts in another surface and modifier keys", () => {
    for (const patch of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }]) {
      expect(resolveCardShortcut({ key: "1", ...patch }, ready)).toBeNull();
      expect(resolveCardShortcut({ key: " ", ...patch }, ready)).toBeNull();
    }
    expect(resolveCardShortcut({ key: "1" }, { ...ready, blocked: true })).toBeNull();
    expect(resolveCardShortcut({ key: "1" }, { ...ready, disabled: true })).toBeNull();
    expect(resolveCardShortcut({ key: " " }, { ...ready, disabled: true })).toBeNull();
    expect(resolveCardShortcut({ key: "x" }, ready)).toBeNull();
  });
  it("uses a disabled native button while saving and never renders the concealed answer", () => {
    const html = renderToStaticMarkup(createElement(CardStack, { front: "问题", back: "隐藏答案", flipped: false, disabled: true, remaining: 2, onFlip: () => undefined, onGrade: () => undefined }));
    expect(html).toMatch(/<button[^>]*disabled=""/);
    expect(html).toContain("问题");
    expect(html).not.toContain("隐藏答案");
    expect(html).toContain('aria-keyshortcuts="Space"');
  });
});
