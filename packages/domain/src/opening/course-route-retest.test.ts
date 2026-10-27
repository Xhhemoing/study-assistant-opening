import { describe,expect,it } from "vitest";
import { courseRouteRetestOutcome } from "./course-route-retest";
const evidence={verifiedCorrect:"yes" as const,independentAttempt:"yes" as const,assistance:"independent" as const,usableForCurrentVersion:"yes" as const};
describe("course retest outcomes",()=>{
  it.each([
    ["completed",null,evidence,"passed"],
    ["completed",null,{...evidence,verifiedCorrect:"no"},"failed"],
    ["completed",null,{...evidence,assistance:"hinted"},"assisted"],
    ["completed",null,{...evidence,verifiedCorrect:"unknown"},"insufficient_evidence"],
    ["accepted","2026-10-26T00:00:00Z",null,"expired"],
    ["cancelled",null,evidence,"cancelled"],
  ] as const)("maps %s and effective evidence to %s",(status,deadlineAt,observation,expected)=>{
    expect(courseRouteRetestOutcome({status,deadlineAt,observation},new Date("2026-10-27T00:00:00Z"))).toBe(expected);
  });
  it("does not downgrade a completed valid answer because its former deadline elapsed",()=>{
    expect(courseRouteRetestOutcome({status:"completed",deadlineAt:"2026-10-26T00:00:00Z",observation:evidence},new Date("2026-10-27T00:00:00Z"))).toBe("passed");
  });
  it("keeps late answers and interval help/practice out of a clean delayed pass",()=>{
    const base={status:"completed",deadlineAt:"2026-10-26T00:00:00Z",observation:evidence};
    expect(courseRouteRetestOutcome({...base,submittedAt:"2026-10-27T00:00:00Z"},new Date("2026-10-27T00:00:00Z"))).toBe("expired");
    expect(courseRouteRetestOutcome({...base,deadlineAt:null,recordedIntervalHelp:true},new Date())).toBe("assisted");
    expect(courseRouteRetestOutcome({...base,deadlineAt:null,recordedIntervalPractice:true},new Date())).toBe("insufficient_evidence");
  });
});
