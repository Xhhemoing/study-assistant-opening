import { expect, it } from "vitest";
import { buildWorkedExampleProviderInput, parseWorkedExampleOutput } from "./worked-example-producer";
import { buildAnswerGradingInput, FOLLOW_UP_GENERATION_CONSTRAINTS } from "./answer-grading";
const input = { originalExample: "求极限 $\\lim_{x\\to0}\\sin(2x)/x$。先用标准极限，结果为2。" };
const proposal = { problem: "求极限 $\\lim_{x\\to0}\\sin(3x)/x$。", workedSolution: "令 t=3x，则 sin(3x)/x=3 sin(t)/t。t趋于0，标准极限为1，故结果为3。" };
it("reuses follow-up constraints but asks for a distinct full example, not fake grading", () => {
  const request = buildWorkedExampleProviderInput(input);
  const grading = buildAnswerGradingInput({ question: "q", answer: "a", referenceText: "", imageParts: [] });
  expect(request.instruction).toContain(FOLLOW_UP_GENERATION_CONSTRAINTS);
  expect(grading.instruction).toContain(FOLLOW_UP_GENERATION_CONSTRAINTS);
  expect(JSON.parse(request.text)).toEqual({ originalExample: input.originalExample });
  expect(request.chunks).toEqual([]); expect(request.imageParts).toEqual([]);
  expect(request.instruction).toContain("workedSolution");
  expect(request.text).not.toContain("studentAnswer");
});
it("admits synthetic calculus output without claiming mathematical verification", () => {
  expect(parseWorkedExampleOutput(JSON.stringify(proposal), input)).toEqual(proposal);
});
it("refuses copied question even when the source also includes its solution", () => {
  expect(() => parseWorkedExampleOutput(JSON.stringify({ ...proposal, problem: "求极限 $\\lim_{x\\to0}\\sin(2x)/x$。" }), input)).toThrow("repeats");
});
it.each([
  { problem: proposal.problem, explanation: "option A" },
  { ...proposal, options: [] }, { ...proposal, workedSolution: "" },
  { ...proposal, workedSolution: "<img src=x onerror=evil>" },
  { ...proposal, verified: true },
])("rejects incomplete, unsafe or authority-bearing output", output => {
  expect(() => parseWorkedExampleOutput(JSON.stringify(output), input)).toThrow();
});
it("rejects bad JSON, oversized output and invalid source without echoing model text", () => {
  expect(() => parseWorkedExampleOutput("secret invalid", input)).toThrow("not valid JSON");
  expect(() => parseWorkedExampleOutput("x".repeat(32001), input)).toThrow("too large");
  expect(() => buildWorkedExampleProviderInput({ originalExample: " " })).toThrow();
});
