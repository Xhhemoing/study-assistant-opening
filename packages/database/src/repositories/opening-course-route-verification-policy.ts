import { COURSE_SPAN_PUBLIC_TEACHING_LIMIT, type CourseRouteRequirementInput, type CourseRouteSnapshot } from "@aistudy/contracts";
import { listSpanTeachingProblems, SPAN_REQUIREMENT_KEY } from "@aistudy/domain";
import { getSpanTeachingProblem, listSpanReservedProblems } from "@aistudy/domain/span-heldout-catalog";
import { listGeneratedSpanItems } from "../../../domain/src/opening/span-generated-items";
import { learningError } from "./opening-learning-facts";

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
  // Unchanged stored rows must not gain a revision just because the explanatory text differs;
  // exact reasons always follow the current switch and sources.
  if (result.kind !== "exact" && result.status !== "ready" && previous?.kind === result.kind && previous.status === result.status &&
      previous.exerciseKeys.length === 0 && normalize(previous.rubric) === normalize(rubric)) return previous;
  return result;
}

/** Public metadata only: no reserved identities, operands, stems or answers. */
export function readCourseSpanBindingOptions(): NonNullable<CourseRouteSnapshot["spanBindingOptions"]> {
  const teaching = listSpanTeachingProblems();
  if (teaching.length > COURSE_SPAN_PUBLIC_TEACHING_LIMIT || teaching.some(problem => problem.version !== "1" || ![2, 3].includes(problem.target.length)))
    throw learningError("CONFLICT", "当前 span 内容版本不支持课程绑定。");
  const validation = listSpanReservedProblems("validation");
  return teaching.filter(problem => validation.some(candidate => candidate.familyId === problem.familyId && candidate.target.length === problem.target.length))
    .map(problem => ({ id: problem.id, version: "1", familyId: problem.familyId,
    dimension: problem.target.length === 2 ? 2 : 3,
    supportedScope: `两生成向量的线性组合；${problem.target.length} 维；${problem.familyId}；确认范围包含现有版本 1 同题族同维度的有限教学与验证内容；向量方程、系数与全部坐标核对，不代表已掌握其他先修。` }));
}

/** Only IDs from the public catalogue are user-confirmable. Expansion is finite and server-owned. */
export function resolveCourseSpanExerciseKeys(publicIds: readonly string[]): string[] {
  return expandCourseSpanExerciseKeys(publicIds, true);
}

function expandCourseSpanExerciseKeys(publicIds: readonly string[], includeGeneratedTeaching: boolean): string[] {
  const options = readCourseSpanBindingOptions();
  if (!publicIds.length || publicIds.length > options.length || new Set(publicIds).size !== publicIds.length)
    throw learningError("VALIDATION", "请显式确认有界且不重复的公开 span 教学内容。");
  const selected = publicIds.map(id => options.find(option => option.id === id));
  if (selected.some(option => !option)) throw learningError("VALIDATION", "只能确认当前公开 span 教学内容，不能提交保留题或任意题目标识。");
  const teaching = listSpanTeachingProblems(), validation = listSpanReservedProblems("validation");
  const matches = (problem: (typeof teaching)[number]) => selected.some(option => option!.familyId === problem.familyId && option!.dimension === problem.target.length);
  // Enumerate only the shipped canonical bank, never parse arbitrary client keys or generate other seeds.
  const generated = includeGeneratedTeaching ? listGeneratedSpanItems("teaching") : [];
  const problems = [...teaching, ...generated, ...validation].filter(matches);
  if (generated.filter(matches).some(problem => getSpanTeachingProblem(problem.id, problem.version)?.id !== problem.id))
    throw learningError("CONFLICT", "当前 span 教学内容没有受支持的 canonical 身份。");
  if (selected.some(option => !validation.some(problem => problem.familyId === option!.familyId && problem.target.length === option!.dimension)))
    throw learningError("CONFLICT", "所确认的 span 范围尚无同题族与维度的验证内容。");
  if (problems.some(problem => problem.version !== "1") || new Set(problems.map(problem => problem.id)).size !== problems.length)
    throw learningError("CONFLICT", "当前 span 内容存在不支持的版本身份。");
  return problems.map(problem => problem.id).sort();
}

/** Accept exact legacy or expanded finite sets; a read never grants missing generated identities. */
export function readConfirmedCourseSpanExerciseKeys(requirementKey: string, verification: Verification): string[] | null {
  if (requirementKey !== SPAN_REQUIREMENT_KEY || verification.kind !== "exact" || verification.status !== "ready" || !verification.exerciseKeys.length) return null;
  const publicIds = readCourseSpanBindingOptions().filter(option => verification.exerciseKeys.includes(option.id)).map(option => option.id);
  if (!publicIds.length) return null;
  for (const includeGeneratedTeaching of [false, true]) {
    const expected = expandCourseSpanExerciseKeys(publicIds, includeGeneratedTeaching);
    if (expected.length === verification.exerciseKeys.length && new Set(verification.exerciseKeys).size === expected.length
      && expected.every(id => verification.exerciseKeys.includes(id))) return [...verification.exerciseKeys];
  }
  return null;
}
