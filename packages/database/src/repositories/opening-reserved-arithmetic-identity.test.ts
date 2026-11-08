import { expect, it } from "vitest";
import { reservedArithmeticIdentity, reservedArithmeticExposureText } from "./opening-reserved-arithmetic-identity";
import { extractCourseQuestionExposure } from "./opening-course-question-exposure";

it.each(["137 · 19", "137 × 19", "137\\times19", "$137*19$", "$$137*19$$", "\\(137*19\\)", "\\[137*19\\]", "计算： $137*19$ = ?"])("canonicalizes the complete supported rendering %s", text => {
  expect(reservedArithmeticIdentity(text)).toEqual(reservedArithmeticIdentity("137*19"));
  expect(reservedArithmeticExposureText(`Example: ${text}`)).toMatchObject({ complete: true, identity: { expression: "137*19" } });
});
it("keeps exact rational grammar and different expressions with the same answer distinct", () => {
  expect(reservedArithmeticIdentity("$\\frac{1}{2}+3$" )).toEqual(reservedArithmeticIdentity("(1/2)+3"));
  expect(reservedArithmeticIdentity("2+3")?.value).toBe(reservedArithmeticIdentity("1+4")?.value);
  expect(reservedArithmeticIdentity("2+3")?.expression).not.toBe(reservedArithmeticIdentity("1+4")?.expression);
});
it.each(["137*", "$137*19", "137^19", "x+1", "1/0", "1 1/2 + 3", "137*19 if x>0", "137*19, truncated",
  "137*19 (unsolved)", "Example: 137 · 19 +", "Example: 137*19 then x+1", "See 137*19 in figure", "137*19 and $unknown$", "Example: 137 -", "137 -", "x-y", "137 ·"])("does not certify a partial/unsupported surface %s", text => {
  expect(reservedArithmeticIdentity(text)).toBeNull();
  expect(extractCourseQuestionExposure(text).complete).toBe(false);
});
it("does not lose a middle-dot expression in a complete example", () => {
  expect(extractCourseQuestionExposure("Example: 137 · 19")).toMatchObject({ complete: true, expressions: ["137*19"] });
});
