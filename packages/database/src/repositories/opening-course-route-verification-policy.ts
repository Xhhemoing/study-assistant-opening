import type { CourseRouteRequirementInput } from "@aistudy/contracts";

type Verification = CourseRouteRequirementInput["verification"];

export function decideCourseRouteVerification(
  submitted: Verification, previous: Verification | null, sourcesAvailable: boolean, exactVerificationEnabled: boolean,
): Verification {
  const { kind, rubric } = submitted;
  if (kind === "unavailable") return { kind, status: "missing", exerciseKeys: [], rubric, missingReasons: ["尚未确认本要求的题目与判定标准"] };
  if (kind === "exact") {
    const ready = exactVerificationEnabled && sourcesAvailable;
    return { kind, status: ready ? "ready" : "missing", exerciseKeys: [], rubric,
      missingReasons: ready ? [] : [!exactVerificationEnabled ? "确定性判定能力尚未开启" : "本要求的来源材料不可用"] };
  }
  const normalize = (value: string | null) => value === null ? null : value.trim().replace(/\s+/gu, " ");
  if (previous?.kind === kind && previous.status === "ready" && normalize(previous.rubric) === normalize(rubric)) return previous;
  return { kind, status: "needs_check", exerciseKeys: [], rubric, missingReasons: ["请先确认本要求的题目与判定标准"] };
}
