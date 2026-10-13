import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DraftConflictPanel } from "./draft-conflict-panel";

const noop = () => undefined;
const base = { diff: null, busy: false, savedAsNewHref: null, relationNote: null, onViewDiff: noop, onSaveAsNew: noop, onDiscard: noop, onCancelDiscard: noop };

describe("DraftConflictPanel (G2)", () => {
  it("offers view diff / save as new / discard, and discard needs a second confirmation", () => {
    const html = renderToStaticMarkup(createElement(DraftConflictPanel, { ...base, reason: "stale-base", confirmingDiscard: false }));
    expect(html).toContain("查看差异");
    expect(html).toContain("另存为新笔记");
    expect(html).toContain("放弃本地修改…");
    expect(html).not.toContain('data-confirm-discard="true"');
    expect(html).toContain("不会被自动覆盖或删除");
    const confirming = renderToStaticMarkup(createElement(DraftConflictPanel, { ...base, reason: "stale-base", confirmingDiscard: true }));
    expect(confirming).toContain('data-confirm-discard="true"');
  });

  it("explains legacy drafts", () => {
    const html = renderToStaticMarkup(createElement(DraftConflictPanel, { ...base, reason: "legacy-draft", confirmingDiscard: false }));
    expect(html).toContain("旧版本编辑器");
  });

  it("editor deletes the local draft only via explicit discard / save-as-new paths", () => {
    const src = readFileSync(resolve(__dirname, "document-editor.tsx"), "utf8");
    const removals = src.match(/localStorage\.removeItem/g) ?? [];
    expect(removals).toHaveLength(1);
    const callers = src.match(/discardLocalAndReload\(/g) ?? [];
    // definition + confirmed-discard + after successful save-as-new
    expect(callers).toHaveLength(3);
    expect(src).not.toContain("重新加载最新版本");
    expect(src).not.toMatch(/localTime > serverTime/);
  });
});
