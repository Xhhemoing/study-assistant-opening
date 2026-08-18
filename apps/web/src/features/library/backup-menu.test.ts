import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BackupMenu } from "./backup-menu";

describe("native backup menu", () => {
  it("renders export, restore, and an explicit non-overwrite conflict policy", () => {
    const html = renderToStaticMarkup(createElement(BackupMenu));
    expect(html).toContain("导出完整备份");
    expect(html).toContain("恢复备份");
    expect(html).toContain("拒绝");
    expect(html).toContain("跳过");
    expect(html).toContain("不会覆盖");
    expect(html).not.toMatch(/无损|lossless/i);
    expect(html).not.toContain("style=");
  });
});
