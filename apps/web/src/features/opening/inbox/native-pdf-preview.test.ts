import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { fitPdfHref, NativePdfPreview } from "./native-pdf-preview";

it("requests native page-width fitting without losing the signed same-origin path or explicit page", () => {
  expect(fitPdfHref("/api/source?version=2#page=3")).toBe("/api/source?version=2#page=3&view=FitH&navpanes=0");
  expect(fitPdfHref("/api/source?version=2")).toBe("/api/source?version=2#view=FitH&navpanes=0");
});
it("retains the original PDF frame when opening a separate fit-width reading surface", () => {
  const html = renderToStaticMarkup(createElement(NativePdfPreview, { href: "/api/source#page=3", name: "lesson", fillHeight: true, toolsOpen: true }));
  expect(html.match(/<iframe/g)).toHaveLength(2);
  expect(html).toContain("侧栏适宽预览");
  expect(html).toContain("两处滚动页不自动同步");
});
