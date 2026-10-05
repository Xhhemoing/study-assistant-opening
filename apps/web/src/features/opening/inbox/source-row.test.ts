import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { SourceRow } from "./source-row";

it("labels parse failure recovery as re-parse", () => {
  const html = renderToStaticMarkup(createElement(SourceRow, {
    record: {
      id: "11111111-1111-4111-8111-111111111111",
      name: "failed.pdf",
      mime: "application/pdf",
      bytes: 20,
      createdAt: "2026-10-04T00:00:00.000Z",
      uploadState: "uploaded",
      parseState: "failed",
    },
    onRetry: () => {},
  }));
  expect(html).toContain("重新解析");
});
