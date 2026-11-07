import type { CourseRouteRequirementInput } from "@aistudy/contracts";

type Verification = CourseRouteRequirementInput["verification"];

export function decideCourseRouteVerification(
  submitted: Verification, previous: Verification | null, sourcesAvailable: boolean, exactVerificationEnabled: boolean,
): Verification {
  const { kind, rubric } = submitted;
  const normalize = (value: string | null) => value === null ? null : value.trim().replace(/\s+/gu, " ");
  let result: Verification;
  if (kind === "unavailable") {
    result = { kind, status: "missing", exerciseKeys: [], rubric, missingReasons: ["尚未确认本要求的题目与判定标准"] };
  } else if (kind === "exact") {
    const ready = exactVerificationEnabled && sourcesAvailable;
    result = { kind, status: ready ? "ready" : "missing", exerciseKeys: [], rubric,
      missingReasons: ready ? [] : [!exactVerificationEnabled ? "确定性判定能力尚未开启" : "本要求的来源材料不可用"] };
  } else {
    if (previous?.kind === kind && previous.status === "ready" && normalize(previous.rubric) === normalize(rubric)) return previous;
    result = { kind, status: "needs_check", exerciseKeys: [], rubric, missingReasons: ["请先确认本要求的题目与判定标准"] };
  }
  // Unchanged stored rows must not gain a revision just because the explanatory text differs.
  if (result.status !== "ready" && previous?.kind === result.kind && previous.status === result.status &&
      previous.exerciseKeys.length === 0 && normalize(previous.rubric) === normalize(rubric)) return previous;
  return result;
}
