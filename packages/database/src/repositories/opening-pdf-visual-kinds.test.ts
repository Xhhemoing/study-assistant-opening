import { expect, it } from "vitest";
import { validatePdfSegmentPages } from "./opening-pdf-segments";

it("preserves layout evidence when a parsed segment is cached and replayed", () => {
  const page = { page: 1, text: "Caption beside a formula", imagePath: null, visualKinds: ["formula", "picture"] };
  expect(validatePdfSegmentPages([page], 1, 1)).toEqual([page]);
});
it("rejects untrusted visual classifications rather than skipping visual extraction", () => {
  expect(() => validatePdfSegmentPages([{ page: 1, text: "x", imagePath: null, visualKinds: ["ignore-ocr"] }], 1, 1)).toThrow();
});
