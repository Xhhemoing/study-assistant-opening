import { describe,expect,it } from "vitest";
import { proofFeedbackAllowsOutcome,proofFeedbackRequiredByQuestion } from "./proof-feedback";
const step={stepIndex:1,claim:"v非零",required:true,verdict:"correct" as const,feedback:"条件明确",repairPrompt:"继续核对等式"};
describe("proof feedback acceptance",()=>{
  it("requires step evidence for explicit proof commands while preserving ordinary legacy questions",()=>{
    for(const stem of ["设Av=λv，证明A²v=λ²v。","请推导下一行。","（1）证明任意两个奇数之和是偶数。","1.证明A²v=λ²v。","Prove that x=y.","Show that A is invertible."])expect(proofFeedbackRequiredByQuestion(stem)).toBe(true);
    for(const stem of ["计算1+1。","不需要证明，写出结果。","解释证明的含义。"])expect(proofFeedbackRequiredByQuestion(stem)).toBe(false);
  });
  it.each(["incorrect","unverified"] as const)("does not accept a correct total with a necessary %s step",verdict=>{
    expect(proofFeedbackAllowsOutcome("correct",{coverage:"complete",steps:[{...step,verdict}]})).toBe(false);
  });
  it("requires complete proof coverage before a positive proof result",()=>{
    expect(proofFeedbackAllowsOutcome("correct",{coverage:"partial",steps:[step]})).toBe(false);
    expect(proofFeedbackAllowsOutcome("correct",{coverage:"complete",steps:[step]})).toBe(true);
    expect(proofFeedbackAllowsOutcome("correct",{coverage:"complete",steps:[{...step,required:false}]})).toBe(false);
    expect(proofFeedbackAllowsOutcome("correct",undefined)).toBe(true);
  });
});
