import { expect, it } from "vitest";
import { photoQuestionRecognitionInputSchema, photoQuestionRecognitionProposalSchema, photoQuestionRecognitionResponseSchema } from "./photo-question-recognition";
const input = { sourceId: "11111111-1111-4111-8111-111111111111", sourceVersion: 0 };
it("accepts an initial source version and bounded uncertain transcription without answer fields", () => {
  expect(photoQuestionRecognitionInputSchema.parse(input)).toEqual(input);
  expect(photoQuestionRecognitionProposalSchema.parse({ stem: "计算【待核对】+1", uncertainFragments: [{ fragment: "【待核对】", reason: "数字模糊" }] }).stem).toContain("待核对");
});
it.each([{ stem: "题目", uncertainFragments: [], answer: "2" }, { stem: "", uncertainFragments: [] }, { stem: "x".repeat(2001), uncertainFragments: [] }])("rejects untrusted model output %j", value => {
  expect(photoQuestionRecognitionProposalSchema.safeParse(value).success).toBe(false);
});
it("does not accept a pending job as a ready transcription", () => {
  expect(photoQuestionRecognitionResponseSchema.safeParse({ ...input, jobId: null, status: "queued", proposal: { stem: "题目", uncertainFragments: [] } }).success).toBe(false);
});
