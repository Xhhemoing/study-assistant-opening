import { expect, it } from "vitest";
import { validatePdfSegmentPages } from "./opening-pdf-segments";

it("preserves layout evidence when a parsed segment is cached and replayed", () => {
  const page = { page: 1, text: "Caption beside a formula", imagePath: null, visualKinds: ["formula", "picture"] };
  expect(validatePdfSegmentPages([page], 1, 1)).toEqual([page]);
});
it("rejects untrusted visual classifications rather than skipping visual extraction", () => {
  expect(() => validatePdfSegmentPages([{ page: 1, text: "x", imagePath: null, visualKinds: ["ignore-ocr"] }], 1, 1)).toThrow();
});
it("preserves optional sectionSealedAtEnd metadata and rejects non-boolean values", () => {
  const sealedPage = { page: 1, text: "Public theorem.", imagePath: null, visualKinds: [], sectionSealedAtEnd: true };
  expect(validatePdfSegmentPages([sealedPage], 1, 1)).toEqual([sealedPage]);
  const plainPage = { page: 1, text: "Public theorem.", imagePath: null };
  expect(validatePdfSegmentPages([plainPage], 1, 1)).toEqual([plainPage]);
  expect("sectionSealedAtEnd" in validatePdfSegmentPages([plainPage], 1, 1)[0]!).toBe(false);
  expect(() => validatePdfSegmentPages([{ page: 1, text: "x", imagePath: null, sectionSealedAtEnd: "yes" }], 1, 1)).toThrow();
});
