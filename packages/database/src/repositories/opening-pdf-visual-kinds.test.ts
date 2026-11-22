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
  const inlineSealedPage = { page: 1, text: "Public stem.", imagePath: null, visualKinds: ["picture"], inlineSealedAtEnd: true, hadSealedContent: true };
  expect(validatePdfSegmentPages([inlineSealedPage], 1, 1)).toEqual([inlineSealedPage]);
  const plainPage = { page: 1, text: "Public theorem.", imagePath: null };
  expect(validatePdfSegmentPages([plainPage], 1, 1)).toEqual([plainPage]);
  const validatedPlain = validatePdfSegmentPages([plainPage], 1, 1)[0]!;
  expect("sectionSealedAtEnd" in validatedPlain).toBe(false);
  expect("inlineSealedAtEnd" in validatedPlain).toBe(false);
  expect("hadSealedContent" in validatedPlain).toBe(false);
  expect(() => validatePdfSegmentPages([{ page: 1, text: "x", imagePath: null, sectionSealedAtEnd: "yes" }], 1, 1)).toThrow();
  expect(() => validatePdfSegmentPages([{ page: 1, text: "x", imagePath: null, inlineSealedAtEnd: "yes" }], 1, 1)).toThrow();
  expect(() => validatePdfSegmentPages([{ ...inlineSealedPage, sectionSealedAtEnd: true }], 1, 1)).toThrow();
  expect(() => validatePdfSegmentPages([{ page: 1, text: "x", imagePath: null, hadSealedContent: "yes" }], 1, 1)).toThrow();
});
it("roundtrips explicit worked-example context on a cached physical page", () => {
  const page = { page: 1, text: "Worked Example 1", imagePath: null };
  for (const inWorkedExampleAtEnd of [true, false]) {
    const annotated = { ...page, inWorkedExampleAtEnd };
    expect(validatePdfSegmentPages([annotated], 1, 1)).toEqual([annotated]);
  }
  expect(() => validatePdfSegmentPages([{ ...page, inWorkedExampleAtEnd: "true" }], 1, 1)).toThrow();
});

it("keeps publication uncertainty separate from a confirmed answer seal", () => {
  const marker = { page: 4, text: "", imagePath: null, hadSealedContent: false, publicationSealUnknown: true };
  expect(validatePdfSegmentPages([marker], 4, 4)).toEqual([marker]);
  expect(() => validatePdfSegmentPages([{ ...marker, publicationSealUnknown: "true" }], 4, 4)).toThrow();
});

it("preserves whether a confirmed publication seal followed public text", () => {
  const marker = { page: 4, text: "", imagePath: null, hadSealedContent: true, sectionSealedAtEnd: true };
  for (const publicationSealHadPublicPrefix of [true, false]) {
    const annotated = { ...marker, publicationSealHadPublicPrefix };
    expect(validatePdfSegmentPages([annotated], 4, 4)).toEqual([annotated]);
  }
  expect(() => validatePdfSegmentPages([{ ...marker, publicationSealHadPublicPrefix: "true" }], 4, 4)).toThrow();
});
