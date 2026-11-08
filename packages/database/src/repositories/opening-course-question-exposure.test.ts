import { expect, it } from "vitest";
import { extractCourseQuestionExposure } from "./opening-course-question-exposure";

it("matches exact arithmetic across UUIDs and formatting without treating family as identity", () => {
  const one = extractCourseQuestionExposure({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", text: "计算 137 × 19" });
  const two = extractCourseQuestionExposure({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", text: "137*19 = ?" });
  expect(one).toEqual(two);
  expect(one).toEqual({ complete: true, expressions: ["137*19"], families: ["arithmetic:*"] });
  const different = extractCourseQuestionExposure("139*23");
  expect(different.families).toEqual(one.families);
  expect(different.expressions).not.toEqual(one.expressions);
});
it("covers teaching/example/hint/nested checkpoint text, not only submitted prompts", () => {
  expect(extractCourseQuestionExposure({ blocks: [{ type: "example", content: { text: "Example: 137*19" } }],
    hints: { firstStep: "139*23" }, checkpoint: { presented: "141*29" } })).toEqual({ complete: true,
    expressions: ["137*19", "139*23", "141*29"], families: ["arithmetic:*"] });
});
it.each([{ text: "Compute (137+2)*19 = ? in the figure" }, { imageObjectKey: "private/figure" },
  { vector: [1, 2] }, { status: "outcome_unknown" }, { text: "Example \\frac{1}{2}+3" }])("keeps partial or unknown surfaces incomplete %#", body => {
  expect(extractCourseQuestionExposure(body).complete).toBe(false);
});
