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
  const sealedPage = { page: 1, text: "Public theorem.", imagePath: null, visualKinds: [], sectionSealedAtEnd: true, hadSealedContent: true };
  expect(validatePdfSegmentPages([sealedPage], 1, 1)).toEqual([sealedPage]);
  const inlineSealedPage = { page: 1, text: "Public stem.", imagePath: null, visualKinds: ["picture"], hadSealedContent: true };
  expect(validatePdfSegmentPages([inlineSealedPage], 1, 1)).toEqual([inlineSealedPage]);
  const plainPage = { page: 1, text: "Public theorem.", imagePath: null };
  expect(validatePdfSegmentPages([plainPage], 1, 1)).toEqual([plainPage]);
  const validatedPlain = validatePdfSegmentPages([plainPage], 1, 1)[0]!;
  expect("sectionSealedAtEnd" in validatedPlain).toBe(false);
  expect("hadSealedContent" in validatedPlain).toBe(false);
  expect(() => validatePdfSegmentPages([{ page: 1, text: "x", imagePath: null, sectionSealedAtEnd: "yes" }], 1, 1)).toThrow();
  expect(() => validatePdfSegmentPages([{ page: 1, text: "x", imagePath: null, hadSealedContent: "yes" }], 1, 1)).toThrow();
});
