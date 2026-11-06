import { checkArithmeticAnswer } from "@aistudy/domain";

/** A bounded exact-arithmetic tool, not a symbolic formula or teaching-claim verifier. */
export async function checkTeachingFormula(
  latex: string,
): Promise<{ ok: boolean } | { unknown: true; reason: string }> {
  const equals = latex.indexOf("=");
  if (equals < 0) return { unknown: true, reason: "exact arithmetic tool requires an equality" };
  const checked = checkArithmeticAnswer(latex.slice(0, equals), latex);
  if (checked === null) {
    return { unknown: true, reason: "equality is outside the supported exact arithmetic language or limits" };
  }
  return { ok: checked === "correct" };
}
