import { z } from "zod";
import type { LoopMetric } from "@aistudy/contracts";
import { captureNextLearningStep, NEXT_LEARNING_STEP_VERSION } from "./adaptive/next-learning-step";
import { recommendTutorAction } from "./tutor-policy";
import { courseRouteRetestOutcome } from "./course-route-retest";
import { evaluateEvidenceEligibility } from "./evidence-eligibility";
import { buildMeasurementReport } from "./measurement/report";

const text = z.string().min(1);
const qualification = z.enum(["yes", "no", "unknown"]);
const assistance = z.enum(["independent", "hinted", "revealed", "unknown"]);
const outcome = z.enum(["correct", "incorrect", "unverified"]);
const iso = text.refine(value => Number.isFinite(Date.parse(value)), "Invalid timestamp");
const evidenceState = z.object({
  verifiedCorrect: qualification, independentAttempt: qualification, assistance,
  usableForCurrentVersion: qualification.optional(),
}).strict();
const identity = { attemptId: text.nullish(), problemId: text.nullish(), itemVersionId: text.nullish() };
const observation = z.object({
  ...identity, observationId: text.nullish(), courseId: text.nullish(), requirementKey: text.nullish(),
  startedAt: z.number().finite().nullish(), submittedAt: z.number().finite().nullish(),
  assistance: assistance.nullish(), outcome: outcome.nullish(),
  verdictSource: z.enum(["self_report", "reference_checked", "model_suggestion", "unknown", "deterministic", "ai_graded"]).nullish(),
}).strict();
// Deliberately bounded fixture vocabulary. Unsupported server/AI envelopes are rejected,
// not cast into trusted facts; this runner never acquires grading authority.
const context = z.object({
  selfReportedAnswerConditions: z.object({ copiedAnswer: z.boolean(), reportedGuess: z.boolean() }).strict().optional(),
  referenceCheckAuthority: z.enum(["learner", "independent_review"]).nullish(),
  referenceCheck: z.object({ ...identity, referenceId: text.nullish(), method: text.nullish(),
    scope: z.enum(["whole_answer", "partial", "unknown"]).nullish(), checkerId: text.nullish(), outcome: outcome.nullish(),
  }).strict().nullish(),
  helpHistory: z.object({ complete: z.boolean(), answerRecordedAt: z.number().finite().nullish(), exposures: z.array(z.object({
    attemptId: text.nullish(), problemId: text.nullish(), level: z.enum(["hinted", "revealed"]),
    kind: z.enum(["instruction", "hint", "solution", "evaluation_feedback"]).nullish(),
    sameQuestion: z.boolean().optional(), delivered: z.boolean().nullable(), deliveredAt: z.number().finite().nullish(),
    serverOrder: z.enum(["before_answer", "after_answer"]).optional(),
  }).strict()) }).strict().nullish(),
  version: z.object({ applicability: z.enum(["exact", "version_unknown", "changed_needs_check", "unavailable", "privacy_excluded"]),
    currentItemVersionId: text.nullish() }).strict().nullish(),
}).strict();
const entries = [
  z.object({ entry: z.literal("nextLearningStep"), input: z.object({
    status: z.enum(["unobserved", "needs_check", "observed_independent", "needs_review"]),
    wantsFullExplanation: z.boolean(), observations: z.array(evidenceState.extend({
      id: text, skillLabel: text, attemptedAt: iso, problemId: text.nullable(), itemVersionId: text.nullish(),
    }).strict()),
  }).strict() }),
  z.object({ entry: z.literal("tutor.thin"), input: z.object({ skillLabel: text, currentPage: z.number().int().positive().nullable(),
    sourceIds: z.array(text), sessionExposures: z.array(z.enum(["hinted", "revealed"])),
    assistedSuccessOnCurrentItem: z.boolean(), retestDue: z.boolean(), problemRef: text.nullish(),
  }).strict() }),
  z.object({ entry: z.literal("tutor.adaptive"), input: z.object({ nodeId: text, hasCheckedIndependent: z.boolean(),
    hasAssistance: z.boolean(), retestDue: z.boolean() }).strict() }),
  z.object({ entry: z.literal("courseRouteRetestOutcome"), input: z.object({
    status: z.enum(["cancelled", "declined", "invalidated", "superseded", "scheduled", "deferred", "completed"]),
    deadlineAt: iso.nullable(), submittedAt: iso.nullish(), recordedIntervalHelp: z.boolean().optional(),
    recordedIntervalPractice: z.boolean().optional(), observation: evidenceState.nullable(), now: iso,
  }).strict() }),
  z.object({ entry: z.literal("evaluateEvidenceEligibility"), input: z.object({ observation, context }).strict() }),
] as const;
const scalar = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
const assertions = z.record(text, z.array(scalar).min(1)).refine(value => Object.keys(value).length > 0, "Gold must assert an output");
const metadata = z.object({
  caseId: text, scenario: text, initialFactRefs: z.array(text).min(1), versionRefs: z.array(text).min(1),
  goalOrMode: text, typicalError: text,
  gold: z.object({ allowed: assertions, forbidden: z.record(text, z.array(scalar).min(1)),
    expectedReceipt: z.literal("unknown:pure-function-only"),
    forbiddenSideEffects: z.array(text).min(1),
    termination: text,
    stopAt: z.enum(["student_answer", "diagnostic_answer", "student_choice", "student_confirmation", "paused", "pure_function_termination"]),
    waitingFor: z.enum(["answer", "diagnostic_answer", "choice", "confirmation", "pause_resume", "none"]),
  }).strict(),
});
const caseSchema = z.discriminatedUnion("entry", [
  entries[0].extend(metadata.shape).strict(), entries[1].extend(metadata.shape).strict(),
  entries[2].extend(metadata.shape).strict(), entries[3].extend(metadata.shape).strict(),
  entries[4].extend(metadata.shape).strict(),
]);
const fixtureSchema = z.object({ synthetic: z.literal(true), offline: z.literal(true),
  cases: z.array(caseSchema).min(1),
}).strict();
export type TutorL0Fixture = z.infer<typeof fixtureSchema>;
export type TutorL0Case = TutorL0Fixture["cases"][number];

export function parseTutorL0Fixture(value: unknown): TutorL0Fixture {
  const parsed = fixtureSchema.parse(value);
  if (new Set(parsed.cases.map(row => row.caseId)).size !== parsed.cases.length) throw new Error("Duplicate caseId");
  return parsed;
}

/** Owner versions are separate: two existing unversioned functions are labelled as such. */
function entryMetadata(entry: TutorL0Case["entry"]) {
  switch (entry) {
    case "nextLearningStep": return { entrypoint: "adaptive/next-learning-step.captureNextLearningStep", policyVersion: NEXT_LEARNING_STEP_VERSION };
    case "tutor.thin": return { entrypoint: "tutor-policy.recommendTutorAction(thin)", policyVersion: "unversioned:thin-existing-rules" };
    case "tutor.adaptive": return { entrypoint: "tutor-policy.recommendTutorAction(adaptive)", policyVersion: "unversioned:adaptive-existing-rules" };
    case "courseRouteRetestOutcome": return { entrypoint: "course-route-retest.courseRouteRetestOutcome", policyVersion: "unversioned:course-route-retest-existing-rules" };
    case "evaluateEvidenceEligibility": return { entrypoint: "evidence-eligibility.evaluateEvidenceEligibility", policyVersion: "opening-evidence-v4" };
  }
}
export function executeTutorL0Case(row: TutorL0Case): unknown {
  switch (row.entry) {
    case "nextLearningStep": return captureNextLearningStep(row.input);
    case "tutor.thin": return recommendTutorAction(row.input);
    case "tutor.adaptive": return recommendTutorAction(row.input);
    case "courseRouteRetestOutcome": return courseRouteRetestOutcome(row.input, new Date(row.input.now));
    case "evaluateEvidenceEligibility": return evaluateEvidenceEligibility(row.input.observation, row.input.context);
  }
}
function atPath(value: unknown, path: string): unknown {
  if (path === "$") return value;
  return path.split(".").reduce<unknown>((current, key) => current !== null && typeof current === "object"
    && Object.hasOwn(current, key) ? (current as Record<string, unknown>)[key] : undefined, value);
}
export function judgeTutorL0Output(row: TutorL0Case, output: unknown) {
  if (output === undefined || output === null) return { status: "missing_output" as const, violations: ["output_missing"] };
  const violations: string[] = [];
  for (const [path, values] of Object.entries(row.gold.allowed)) {
    const actual = atPath(output, path);
    if (!values.some(value => value === actual)) violations.push(`not_allowed:${path}`);
  }
  for (const [path, values] of Object.entries(row.gold.forbidden)) {
    if (values.some(value => value === atPath(output, path))) violations.push(`forbidden:${path}`);
  }
  return { status: violations.length ? "fail" as const : "pass" as const, violations };
}

/** Only pure rule outputs are evaluated. No action string is converted into a tool receipt. */
export function evaluateTutorL0(value: unknown, execute: (row: TutorL0Case) => unknown = executeTutorL0Case) {
  const fixture = parseTutorL0Fixture(value);
  const cases = fixture.cases.map(row => {
    let actualOutput: unknown;
    let error: string | null = null;
    try { actualOutput = execute(row); } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
    const judgment = error ? { status: "execution_error" as const, violations: [error] } : judgeTutorL0Output(row, actualOutput);
    return { ...row, ...entryMetadata(row.entry), actualOutput: actualOutput ?? null, error, judgment,
      scope: { toolSideEffects: "unknown", teachingSemantics: "unknown", humanLearningEffect: "unknown" } as const };
  });
  const passed = cases.filter(row => row.judgment.status === "pass").length;
  return { synthetic: true, offline: true, evaluatorVersion: "tutor-l0-offline-1", cases,
    summary: { denominator: cases.length, passed, failed: cases.length - passed,
      missing: cases.filter(row => row.judgment.status === "missing_output").length,
      errors: cases.filter(row => row.judgment.status === "execution_error").length,
      rulePassRatio: passed / cases.length, learningEffect: "unknown" },
    measurement: tutorL0MeasurementSkeleton(),
    untested: ["tool calls, persisted receipts and budget release", "cancel/defer persistence and permission revocation",
      "answer-field/plaintext/semantic leakage in model replies", "GPT tutor and GPT student", "cross-family semantic judge and human validation"],
    scriptedStudent: { entrypoint: "adaptive/loop-simulation.test.ts", kind: "existing_scripted_synthetic_student", gptStudent: false },
  };
}

/** Research scaffold only; no observations are accepted and no second mastery ledger is built. */
export function tutorL0MeasurementSkeleton() {
  const definitions = [
    { dimension: "efficiency", timepoint: "immediate", task: "独立解两道未见同族题", rubric: "独立正确数/实际作答分钟；正确率与用时分别保留", unit: "ratio" },
    { dimension: "understanding", timepoint: "immediate", task: "解释一个错误步骤并比较两种解法", rubric: "各题0–2：找出理由、解释适用条件；需独立语义评审", unit: "ratio" },
    { dimension: "exam", timepoint: "post_learning", task: "限时完成两道跨条件题", rubric: "冻结答案，盲评关键步骤和正确率", unit: "ratio" },
    { dimension: "unaided_application", timepoint: "day_7", task: "无AI完成两道同族未见题", rubric: "独立正确率及用时归一化；失访仍列分母", unit: "ratio" },
    { dimension: "unaided_application", timepoint: "day_30", task: "无AI完成两道迁移题", rubric: "独立正确率及用时；期间帮助与练习另列", unit: "ratio" },
    { dimension: "organization", timepoint: "week_1", task: "整理两个目标并在时间约束内选择下一任务", rubric: "目标覆盖、计划冲突、手动组织分钟分别盲评；不以完成率代效果", unit: "ratio" },
  ] as const;
  return { synthetic: true, offline: true, realBenefit: "unknown", calibrated: false,
    protocol: "D1 research scaffold; day_7/day_30 does not replace legacy practice/delay_48h/delay_7d",
    legacyPredictionReport: buildMeasurementReport([]),
    groups: definitions.map(definition => ({ ...definition,
      itemGroupId: `synthetic-${definition.dimension}-${definition.timepoint}`,
      rubricRef: `d1-synthetic-rubric:${definition.dimension}:draft-1`,
      syntheticItems: definition.dimension === "efficiency"
        ? ["判断(2,0),(0,3)能否张成R²并计时", "判断(1,2),(2,4)能否张成R²并计时"]
        : definition.dimension === "understanding"
          ? ["解释‘两个非零向量必张成R²’的错误", "比较消元法与行列式法的适用条件"]
          : definition.dimension === "exam"
            ? ["限时判断(1,0,0),(0,1,0)在R³的张成空间", "限时求参数t使(1,t),(2,4)线性无关"]
            : definition.dimension === "unaided_application"
              ? definition.timepoint === "day_7"
                ? ["无AI判断(3,1),(6,2)是否张成R²", "无AI表达(5,7)为(1,0),(1,1)的线性组合"]
                : ["无AI解释两个共线传感器方向能否重建平面位移", "无AI为三维位移选最小独立方向组并解释"]
              : ["在45分钟内安排复习张成与准备考试两项目标", "任务推迟一天后重排约束并解释目标覆盖"],
      answerOrRubricAnchors: definition.dimension === "organization"
        ? ["总时长不超过45分钟；覆盖两个目标并给出取舍", "尊重推迟与既有承诺；不得自动声称安排已保存"]
        : definition.dimension === "understanding"
          ? ["非零不蕴含线性无关，须给出共线反例", "二维方阵可用非零行列式；一般空间用秩/消元"]
          : definition.dimension === "exam"
            ? ["张成z=0平面，不是R³", "t不等于2"]
            : definition.dimension === "efficiency"
              ? ["是，行列式6非零", "否，第二向量是第一向量的2倍"]
              : definition.timepoint === "day_7"
                ? ["否，共线", "-2倍(1,0)+7倍(1,1)"]
                : ["不能，缺独立方向", "三个线性无关方向；要求具体例子和理由"],
      conditions: ["AI-assisted learning condition pending allocation", "comparison condition pending allocation", "assessment without AI", "consent and human rubric validation pending"],
      observations: null,
      metric: { id: `d1.${definition.dimension}.${definition.timepoint}`, label: definition.task, unit: definition.unit,
        value: null, numerator: null, denominator: 2, sampleSize: 0, dataStatus: "unknown",
        denominatorLabel: "两项预设研究测量槽位，含缺失；未招募、未采集，不是参与者数",
        excludedReasonCounts: { not_observed: 2, synthetic_material: 2 },
      } satisfies LoopMetric,
    })),
  };
}
