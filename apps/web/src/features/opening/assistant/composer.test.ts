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
  it("does not ask learners to choose a purpose or tutoring mode", () => {
    const html = markup(true);
    expect(html).not.toContain('aria-label="本轮目的"');
    expect(html).not.toContain('aria-label="辅导模式"');
    expect(html).toContain('aria-label="消息输入"');
  });

  it("shows saved-only practice privacy, even if a caller passes ephemeral", () => {
    const html = markup(true);
    expect(html).toContain("保存对话");
    expect(html).toContain("练习辅导会保存对话并记录帮助");
    expect(html).not.toContain('value="ephemeral"');
  });

  it("keeps explicit privacy options above the input in the ordinary assistant", () => {
    const html = markup(false);
    const selector = html.match(/<select[^>]*aria-label="隐私模式"[^>]*>.*?<\/select>/)?.[0];
    expect(selector).toContain('value="ephemeral" selected=""');
    expect(selector).not.toContain('disabled=""');
    expect(html.indexOf('aria-label="隐私模式"')).toBeLessThan(html.indexOf("<textarea"));
    expect(html).not.toContain('aria-label="本轮目的"');
    expect(html).not.toContain('aria-label="辅导模式"');
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
  it("changes the logical send when query intent changes and preserves ordinary retry keys", () => {
    const input = { text: "模型设置", mode: "explain" as const, sourceIds: [] };
    const ordinary = logicalSendFingerprint(input);
    expect(logicalSendFingerprint({ ...input, querySystem: false })).toBe(ordinary);
    const query = logicalSendFingerprint({ ...input, querySystem: true });
    expect(query).not.toBe(ordinary);
    expect(nextClientKey({ clientKey: "old-key", fingerprint: ordinary, nextFingerprint: query, mint: () => "new-key" }).clientKey).toBe("new-key");
  });
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

it("does not turn ordinary practice help into an explicit teaching proposal", () => {
  const html = renderToStaticMarkup(createElement(Composer, { practiceMode: true, draft: "给我一个提示", onDraftChange: () => undefined, onSubmit: () => undefined }));
  expect(html).not.toContain("带我学习");
  expect(html).not.toContain("撤回本轮选择");
});

it("does not reuse an unconfirmed send key after changing the material intent", () => {
  const base = { text: "explain", mode: "explain" as const, sourceIds: [] };
  const none = logicalSendFingerprint({ ...base, sourceSelection: "none" });
  const auto = logicalSendFingerprint({ ...base, sourceSelection: "auto" });
  expect(none).not.toBe(auto);
  expect(nextClientKey({ clientKey: "none-key", fingerprint: none, nextFingerprint: auto, mint: () => "auto-key" }).clientKey).toBe("auto-key");
});

describe("compact reader composer", () => {
  it.each(["saved", "ephemeral"] as const)("exposes the current %s privacy in the collapsed settings summary", privacy => {
    const html = renderToStaticMarkup(createElement(Composer, {
      compact: true, privacy, draft: "请解释当前页", onDraftChange() {}, onSubmit() {}, onPrivacyChange() {},
    }));
    const settings = html.match(/<details[^>]*>([\s\S]*?)<\/details>/)?.[0];
    expect(settings).toBeDefined();
    expect(settings).not.toMatch(/<details[^>]*\sopen(?:=|\s|>)/);
    expect(settings?.match(/<summary[^>]*>([\s\S]*?)<\/summary>/)?.[1]).toContain(privacy === "saved" ? "保存" : "临时");
    expect(html).toContain('aria-label="消息输入"');
    expect(html).toContain('aria-label="发送"');
    expect(html).not.toContain('aria-label="本轮目的"');
    if (privacy === "ephemeral") expect(html).toContain("刷新后不会恢复");
  });
  it("keeps saved-only help tracking visible for a real attempt", () => {
    const html = renderToStaticMarkup(createElement(Composer, {
      compact: true, practiceMode: true, privacy: "ephemeral", draft: "提示", onDraftChange() {}, onSubmit() {},
    }));
    expect(html).toContain("练习辅导会保存对话并记录帮助");
    expect(html).not.toContain("刷新后不会恢复");
    expect(html).not.toContain('<option value="ephemeral"');
  });
});
