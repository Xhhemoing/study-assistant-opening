import { describe,expect,it } from "vitest";
import { answerInterpretationCorrectionSchema,proofStepFeedbackSchema } from "./answer-interpretation";
const id="00000000-0000-4000-8000-000000000001";
describe("answer interpretation boundary",()=>{
  it("requires a pinned head and correction reason, never accepts a replacement image or grading outcome",()=>{
    const input={expectedHead:id,correctedTranscription:"1. 假设v非零。\n2. Av=λv。",reason:"漏识别了非零条件",clientKey:"correction-1"};
    expect(answerInterpretationCorrectionSchema.parse(input)).toEqual(input);
    expect(answerInterpretationCorrectionSchema.safeParse({...input,workSource:{id,version:2,physicalPage:1}}).success).toBe(false);
    expect(answerInterpretationCorrectionSchema.safeParse({...input,outcome:"correct"}).success).toBe(false);
  });
  it("pins proof feedback to a numbered required claim and an explicit verdict",()=>{
    expect(proofStepFeedbackSchema.parse({stepIndex:1,claim:"v非零",required:true,verdict:"unverified",feedback:"图片看不清条件",repairPrompt:"确认原图中的条件"}).required).toBe(true);
    expect(proofStepFeedbackSchema.safeParse({stepIndex:0,claim:"x",required:true,verdict:"correct",feedback:"x",repairPrompt:"x"}).success).toBe(false);
  });
});
