import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ExportMenu } from "./export-menu";

describe("markdown export menu", () => {
  it("renders an export action that does not claim a lossless backup", () => {
    const html = renderToStaticMarkup(createElement(ExportMenu));
    expect(html).toContain("导出 Markdown");
    expect(html).toContain("导出 Anki");
    expect(html).toContain("可交换投影");
    expect(html).not.toMatch(/无损|lossless/i);
    expect(html).not.toContain("style=");
  });
});
