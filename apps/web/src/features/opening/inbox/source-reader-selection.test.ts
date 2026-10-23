// @vitest-environment jsdom
import { expect, it } from "vitest";
import { selectedReaderExcerpt } from "./source-reader-selection";

it("carries the actual page and fixed material revision, rejecting another region or revision", () => {
  const root = document.createElement("div");
  root.innerHTML = '<pre data-study-reading-text data-source-id="source" data-source-version="2" data-page-kind="physical" data-source-page="7">第一段</pre><pre data-study-reading-text data-source-id="source" data-source-version="2" data-page-kind="physical" data-source-page="8">第二段</pre>';
  const [a, b] = root.querySelectorAll("pre");
  const selection = { anchorNode: a!.firstChild, focusNode: a!.firstChild, isCollapsed: false, toString: () => "第一段" };
  expect(selectedReaderExcerpt(root, "source", 2, selection)).toEqual({ sourceId: "source", version: 2, page: 7, text: "第一段" });
  expect(selectedReaderExcerpt(root, "source", 3, selection)).toBeNull();
  expect(selectedReaderExcerpt(root, "other", 2, selection)).toBeNull();
  expect(selectedReaderExcerpt(root, "source", 2, { ...selection, focusNode: b!.firstChild })).toBeNull();
  a!.setAttribute("hidden", "");
  expect(selectedReaderExcerpt(root, "source", 2, selection)).toBeNull();
});
