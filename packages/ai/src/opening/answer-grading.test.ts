import { expect, it } from "vitest";
import { buildAnswerGradingInput } from "./answer-grading";
import { rankPedagogy } from "../../../../tests/fixtures/opening/teaching/rank-pedagogy";

it("supplies the saved misconception dictionary separately from student work", () => {
  const input = buildAnswerGradingInput({ question: "3×5矩阵的秩为2，零空间维数？", answer: "3-2=1", referenceText: "5-2=3", imageParts: [], ...rankPedagogy });
  expect(JSON.parse(input.text)).toMatchObject({ studentAnswer: "3-2=1", misconceptions: rankPedagogy.misconceptions });
  expect(input.instruction).toContain("不要发明新的id");
  expect(input.instruction).toContain("followUp 检查同一误解");
});
