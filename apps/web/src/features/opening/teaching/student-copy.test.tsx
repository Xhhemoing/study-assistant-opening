import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { HintLadder } from "./hint-ladder";
import { studentCopy } from "./student-copy";

// Guard the vocabulary boundary, not a frozen copy snapshot. Ordinary teaching
// words such as “独立思考” or mathematical “证明” remain valid.
const measurementTerms = /封存|曝光|回执|题族|资格|BKT|Brier|不计独立|独立答对估计/;
it("keeps the shared student actions free of measurement jargon", () => {
  for (const text of Object.values(studentCopy)) expect(text).not.toMatch(measurementTerms);
});
it("welcomes help without exposing measurement bookkeeping", () => {
  const html = renderToStaticMarkup(createElement(HintLadder, {
    delivered: [], next: { label: "方向提示", pending: false, request() {} },
  }));
  expect(html).not.toMatch(measurementTerms);
  expect(html).toContain(studentCopy.hintEncouragement);
});
