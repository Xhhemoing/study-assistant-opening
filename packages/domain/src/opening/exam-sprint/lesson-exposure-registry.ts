/**
 * Editorial exposure boundaries for the unmodified 2026-10-17-v1 seed prose.
 * These are explicit content associations, not calibrated cognitive equivalence.
 * A prose edit requires reviewing every displayed field and issuing a new mapping.
 */
export const REVIEWED_LESSON_EXPOSURES: Readonly<Record<string, {
  contentFingerprint: string;
  displayedFamilyIds: readonly string[];
  partialFamilyIds: readonly string[];
}>> = {
  // Full quotient, including the worked numerator multiplication. No power example.
  "complex-arithmetic": { contentFingerprint: "ce6b5e83b42f680b6f679022a629243eb64daa6c2a1c6f066da3aff4e124af93", displayedFamilyIds: ["complex-quotient", "complex-product"], partialFamilyIds: [] },
  // All three cube roots are solved; the general n-th-root rule is not a new square-root example.
  "complex-roots": { contentFingerprint: "205c043cd6559b423707a582a1a5b381bcd7f40d30e772f56fdd6ce8833b5da2", displayedFamilyIds: ["complex-nth-roots"], partialFamilyIds: [] },
  "sequence-limits": { contentFingerprint: "0fdc28dd8d130683596529c8d5497b678bd1b1ea3db27fdf0550842ec5114804", displayedFamilyIds: ["radical-rationalization"], partialFamilyIds: [] },
  // The worked recurrence proves monotonicity/bounds; it is not the affine recurrence family.
  // The pitfall explicitly solves the bounded oscillating (-1)^n counterexample as divergent.
  "sequence-properties": { contentFingerprint: "8c2df695c3dda57cf136befff812ec72537593b51852723fa2974c4285764c5e", displayedFamilyIds: ["monotone-bounds", "subsequence-divergence"], partialFamilyIds: [] },
  // The worked cubic limit; steps also give the exact second-order e^x coefficient used by training.
  "derivative-taylor": { contentFingerprint: "98f680ad80b136f57c6b2042d222b950cbe617d84165d69a62cf479a5d4b15b5", displayedFamilyIds: ["taylor-third-order", "taylor-second-order"], partialFamilyIds: [] },
  // The worked cubic gives stationary values for the closed-interval item, but omits its endpoints.
  "curve-analysis": { contentFingerprint: "2634e033da871575f41c79be17882a365ed32ea2abf62d57a7b31ce16f9ad83d", displayedFamilyIds: ["critical-point-extremum", "stationary-non-extremum"], partialFamilyIds: ["closed-interval-extrema"] },
  "integration-parts": { contentFingerprint: "cbc2673ae6590cdc6dc7e113c003edcd2d76a8b15d2ae1361d06f88f30dc2423", displayedFamilyIds: ["parts-exponential"], partialFamilyIds: [] },
  // The explicit coefficient answer is shown; a shared decomposition method alone is insufficient.
  "integration-partial-fractions": { contentFingerprint: "9fa62d2593b23bdb9e5ffb9183bb7a888e560057e133cbc4c2c982a11e82715d", displayedFamilyIds: ["partial-fractions-coefficients"], partialFamilyIds: [] },
  "integral-ftc-applications": { contentFingerprint: "f8ba7b401e03f15af37c48dcedcabac379dd67aa3491906862dc8d8cad756557", displayedFamilyIds: ["area-sign-change", "ftc-upper-chain"], partialFamilyIds: [] },
  // Worked endpoints include the complete alternating harmonic verdict. The p-series rule is general instruction.
  "series-tests": { contentFingerprint: "ae6f24d7bf43f0de2bea2b85dfa22160eab435d338dd71af3eb3d69165fea050", displayedFamilyIds: ["power-series-endpoints", "alternating-absolute"], partialFamilyIds: [] },
  // The moving-peak example is explicit. x/n is only a method comparison for the rational-error item.
  "uniform-convergence": { contentFingerprint: "4ef0e52e47033d923db211f3597c0b9a11d0eb06d9f9b2961e6246a78913debb", displayedFamilyIds: ["uniform-moving-peak"], partialFamilyIds: [] },
};
export const LESSON_EXPOSURE_MAPPING_VERSION = "sprint-seed-exposure-2026-10-20-v1";
