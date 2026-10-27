import type { SnapshotObservation } from "./adaptive/snapshot-sources";
export type CourseRouteRetestOutcome="passed"|"failed"|"assisted"|"insufficient_evidence"|"expired"|"cancelled"|"pending";
export function courseRouteRetestOutcome(input:{status:string;deadlineAt:string|null;submittedAt?:string|null;recordedIntervalHelp?:boolean;recordedIntervalPractice?:boolean;observation:Pick<SnapshotObservation,"verifiedCorrect"|"independentAttempt"|"assistance"|"usableForCurrentVersion">|null},now:Date):CourseRouteRetestOutcome{
  if(["cancelled","declined","invalidated","superseded"].includes(input.status))return "cancelled";
  if(input.deadlineAt&&(input.submittedAt?Date.parse(input.submittedAt)>Date.parse(input.deadlineAt):input.status!=="completed"&&Date.parse(input.deadlineAt)<now.getTime()))return "expired";
  const evidence=input.observation;
  if(!evidence)return input.status==="completed"?"insufficient_evidence":"pending";
  if(evidence.usableForCurrentVersion!=="yes"||evidence.verifiedCorrect==="unknown")return "insufficient_evidence";
  if(evidence.verifiedCorrect==="no")return "failed";
  if(input.recordedIntervalHelp||evidence.assistance==="hinted"||evidence.assistance==="revealed")return "assisted";
  if(input.recordedIntervalPractice)return "insufficient_evidence";
  return evidence.independentAttempt==="yes"&&evidence.assistance==="independent"?"passed":"insufficient_evidence";
}
